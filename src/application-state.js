const fs = require('node:fs');
const path = require('node:path');
const freshState = () => ({ version: 1, offset: 0, acceptAfter: Math.floor(Date.now() / 1000), applications: {} });

function validateState(state) {
  if (state?.version !== 1 || !Number.isSafeInteger(state.offset) || state.offset < 0 ||
      !Number.isSafeInteger(state.acceptAfter) || !state.applications || Array.isArray(state.applications)) {
    throw new Error('Invalid application state. Refusing to start with empty state.');
  }
  for (const [key, value] of Object.entries(state.applications)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !['pending', 'submitted', 'unknown'].includes(value?.status)) {
      throw new Error('Invalid application ledger entry.');
    }
  }
  return state;
}

class GitHubState {
  constructor({ repository, token, branch = 'bot-application-state', fetchImpl = fetch }) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !token) throw new Error('GitHub state credentials missing.');
    this.base = `https://api.github.com/repos/${repository}`;
    this.token = token; this.branch = branch; this.fetch = fetchImpl; this.sha = undefined;
    this.filePath = '/contents/application-state.json';
  }
  async request(resource, method = 'GET', body) {
    let response;
    try {
      response = await this.fetch(this.base + resource, {
        method, headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000),
      });
    } catch { throw new Error('GitHub state network error.'); }
    const data = await response.json().catch(() => null);
    if (!response.ok) { const e = new Error(`GitHub state HTTP ${response.status}`); e.status = response.status; throw e; }
    return data;
  }
  async load() {
    try {
      const result = await this.request(`${this.filePath}?ref=${encodeURIComponent(this.branch)}`);
      this.sha = result.sha;
      this.state = validateState(JSON.parse(Buffer.from(result.content, 'base64').toString('utf8')));
    } catch (e) {
      if (e.status !== 404) throw e;
      // Initialize only if the entire state branch is absent. A missing ledger on an
      // existing branch may represent data loss and must not silently reset deduplication.
      let branchExists = true;
      try { await this.request(`/git/ref/heads/${encodeURIComponent(this.branch)}`); }
      catch (error) { if (error.status === 404) branchExists = false; else throw error; }
      if (branchExists) throw new Error('State branch exists but ledger is missing. Restore it before starting.');
      const repo = await this.request('');
      const ref = await this.request(`/git/ref/heads/${encodeURIComponent(repo.default_branch)}`);
      await this.request('/git/refs', 'POST', { ref: `refs/heads/${this.branch}`, sha: ref.object.sha });
      this.state = freshState();
      await this.save();
    }
    return this.state;
  }
  async save() {
    validateState(this.state);
    const result = await this.request(this.filePath, 'PUT', {
      message: 'Checkpoint application bot state', branch: this.branch,
      content: Buffer.from(JSON.stringify(this.state, null, 2) + '\n').toString('base64'),
      ...(this.sha ? { sha: this.sha } : {}),
    });
    this.sha = result.content.sha;
  }
}

class LocalState {
  constructor(file) { this.file = file; }
  async load() {
    this.state = fs.existsSync(this.file) ? validateState(JSON.parse(fs.readFileSync(this.file, 'utf8'))) : freshState();
    await this.save();
    return this.state;
  }
  async save() {
    validateState(this.state);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.tmp';
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.file);
    // Persist the rename on Linux. Only run ONE local listener per bot/state file.
    if (process.platform === 'linux') {
      const directory = fs.openSync(path.dirname(this.file), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  }
}
module.exports = { GitHubState, LocalState, freshState, validateState };
