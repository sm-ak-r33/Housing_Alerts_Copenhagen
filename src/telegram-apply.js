const { authorize, parseCommand, addressKey, addressText } = require('./application-command');
const { loadProfile, applyForHousing, preparationReason, FORM_URL } = require('./dab-application');
const { GitHubState, LocalState } = require('./application-state');

const HELP = 'Reply directly to a DAB-Lejerbo notification:\napply 1 — select listing 1\napply — if it has just one listing\napply Eksempelvej 12, 2. tv., 2500 Valby — supply the exact address\nA full address alone in a reply also works.\n/status — show mode and ledger counts.\nIn live mode, an apply reply submits immediately without another confirmation.';

async function telegram(token, method, body = {}) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(method === 'getUpdates' ? 55000 : 20000),
    });
  } catch { throw new Error('Telegram network error.'); }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) {
    const e = new Error(`Telegram ${method} failed (HTTP ${response.status}).`);
    e.status = response.status;
    e.retryAfter = result?.parameters?.retry_after;
    throw e;
  }
  return result.result;
}

async function handleUpdate(update, { config, store, send, apply = applyForHousing, now = Math.floor(Date.now() / 1000) }) {
  const m = update.message;
  if (!m || !authorize(m, config) || !m.text) return;
  if (m.date < store.state.acceptAfter || now - m.date > config.maxAgeSeconds) {
    await send('That command is too old. Send a fresh reply to the listing notification.');
    return;
  }
  let command;
  try { command = parseCommand(m); } catch (e) { await send(e.message); return; }
  if (command.kind === 'help') { await send(HELP); return; }
  if (command.kind === 'status') {
    const counts = {};
    for (const value of Object.values(store.state.applications)) counts[value.status] = (counts[value.status] || 0) + 1;
    await send(`Mode: ${config.dryRun ? 'PREVIEW (no submission)' : 'LIVE'}\n${JSON.stringify(counts)}\nPending/unknown entries require manual verification before any retry.`);
    return;
  }
  const key = addressKey(command.address);
  const previous = store.state.applications[key];
  if (previous) {
    await send(`Blocked duplicate: ${addressText(command.address)}\nRecorded status: ${previous.status}. Check your email/site before trying again. Ledger key: ${key}`);
    return;
  }
  await send(`${config.dryRun ? 'Checking form for' : 'Applying for'} ${addressText(command.address)}…`);
  let reserved = false;
  let stateFailure = false;
  let result;
  try {
    result = await apply(command.address, config.profile, {
      dryRun: config.dryRun,
      beforeSubmit: async () => {
        store.state.applications[key] = { status: 'pending', updatedAt: new Date().toISOString() };
        try { await store.save(); } catch (e) { stateFailure = true; throw e; }
        reserved = true;
      },
    });
  } catch (error) {
    if (stateFailure) throw new Error('State reservation failed. No submit click was authorized.');
    if (!reserved) {
      await send(`Could not prepare the form; no submit click was made. ${preparationReason(error)}\n${FORM_URL}`);
      return;
    }
    result = { status: 'unknown' };
  }
  if (result.status === 'preview') {
    await send(`Preview passed for ${addressText(command.address)}. Fields were filled and validated; nothing was submitted. Enable DAB_SUBMIT_ENABLED=true and send a new apply reply to submit.`);
    return;
  }
  if (!reserved) throw new Error('Submit adapter returned without a durable reservation.');
  store.state.applications[key] = { status: result.status === 'submitted' ? 'submitted' : 'unknown', updatedAt: new Date().toISOString() };
  await store.save();
  await send(result.status === 'submitted'
    ? `DAB-Lejerbo confirmed receipt for ${addressText(command.address)}. Check your email. This is an application, not a housing allocation.`
    : `Submission outcome unknown for ${addressText(command.address)}. It will NOT be retried automatically. Check your email/site before retrying. Ledger key: ${key}`);
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const userIds = String(process.env.TELEGRAM_ALLOWED_USER_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!token || !/^-?\d+$/.test(chatId || '') || !userIds.length || userIds.some(id => !/^\d+$/.test(id))) {
    throw new Error('Set TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID and TELEGRAM_ALLOWED_USER_IDS.');
  }
  const maxAgeSeconds = Number(process.env.APPLY_MAX_AGE_SECONDS || 900);
  const duration = Number(process.env.LISTENER_SECONDS || 14700);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) throw new Error('Invalid duration or maximum command age.');
  const config = { chatId, allowedUsers: new Set(userIds), profile: loadProfile(process.env.DAB_APPLICANT_JSON),
    dryRun: process.env.DAB_SUBMIT_ENABLED !== 'true', maxAgeSeconds };
  const me = await telegram(token, 'getMe');
  config.botId = me.id;
  if ((await telegram(token, 'getWebhookInfo')).url) throw new Error('This bot has a webhook. Disable it deliberately before using a polling listener.');
  const store = process.env.GITHUB_ACTIONS === 'true' || process.env.APPLICATION_STATE_BACKEND === 'github'
    ? new GitHubState({ repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN })
    : new LocalState(process.env.APPLICATION_STATE_FILE || '.state/application-state.json');
  await store.load();
  const send = async text => {
    try { await telegram(token, 'sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } }); }
    catch { console.warn('Telegram status notification could not be delivered. Application state remains authoritative.'); }
  };
  console.log(`Reply listener active: ${config.dryRun ? 'PREVIEW' : 'LIVE'}.`);
  const deadline = Date.now() + duration * 1000;
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  while (!stopping && Date.now() < deadline) {
    let updates;
    try {
      updates = await telegram(token, 'getUpdates', { offset: store.state.offset, timeout: 45, limit: 50, allowed_updates: ['message'] });
    } catch (e) {
      if ([401, 403, 409].includes(e.status)) throw e;
      console.warn('Telegram polling failed; backing off.');
      await new Promise(resolve => setTimeout(resolve, Math.min(Number(e.retryAfter) || 5, 60) * 1000));
      continue;
    }
    for (const update of updates) {
      if (stopping) break;
      if (update.update_id < store.state.offset) continue;
      // State errors propagate and stop the process. Never proceed without a durable checkpoint.
      await handleUpdate(update, { config, store, send });
      store.state.offset = update.update_id + 1;
      await store.save();
    }
  }
  console.log('Reply listener stopped cleanly.');
}

if (require.main === module) main().catch(error => {
  // No raw Playwright errors, HTTP request objects, tokens, or applicant data in logs.
  console.error(error.message);
  process.exitCode = 1;
});
module.exports = { handleUpdate, telegram, main };
