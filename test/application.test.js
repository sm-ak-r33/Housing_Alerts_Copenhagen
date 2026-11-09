const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseAddress, addressKey, authorize, parseCommand, LISTINGS_URL } = require('../src/application-command');
const { loadProfile, confirmedResponse } = require('../src/dab-application');
const { handleUpdate } = require('../src/telegram-apply');
const { LocalState, GitHubState, validateState } = require('../src/application-state');
const { buildListingsMessage, splitMessage } = require('../src/check-apartments');

const profile = { name: 'Test Person', email: 'test@example.invalid', phone: '+4512345678', current_street: 'Testvej 1', current_postcode: '2500', current_city: 'Valby' };
const notification = `🏠 Initial DAB-Lejerbo housing snapshot\n1. Eksempelvej 12, 2. tv., 2500 Valby\nPostcode: 2500 Valby\n2. Prøve Allé 4A, st. th., 2000 Frederiksberg\nPostcode: 2000 Frederiksberg\nSource:\n${LISTINGS_URL}`;
const message = (text = 'apply 1') => ({ message_id: 3, text, date: 1000, from: { id: 7 }, chat: { id: 7 }, reply_to_message: { message_id: 2, from: { id: 99, is_bot: true }, text: notification } });
const config = { chatId: '7', allowedUsers: new Set(['7']), botId: 99, maxAgeSeconds: 900, dryRun: false, profile };
function harness() {
  const sent = [], saves = [];
  const store = { state: { version: 1, offset: 0, acceptAfter: 900, applications: {} }, async save() { saves.push(structuredClone(this.state)); } };
  return { config, store, saves, sent, send: async s => sent.push(s), now: 1001 };
}

test('Danish street, flat, postcode and city are separated without losing the unit', () => {
  assert.deepEqual(parseAddress('Prøve Allé 4A, st. th., 2000 Frederiksberg'), { street: 'Prøve Allé 4A, st. th.', postcode: '2000', city: 'Frederiksberg' });
  assert.equal(parseAddress('Eksempelvej 12, 2. tv., 2500 Valby').street, 'Eksempelvej 12, 2. tv.');
  assert.equal(parseAddress('H. C. Andersens Boulevard 10, 1553 København V').city, 'København V');
  for (const input of ['2500 Valby', 'Husleje 12000, 2500 Valby', 'https://bad.example/12, 2500 Valby', 'Eksempelvej 12', 'apply all']) assert.throws(() => parseAddress(input));
});

test('chooses the replied-to listing number and refuses ambiguous apply', () => {
  assert.equal(parseCommand(message('apply 2')).address.street, 'Prøve Allé 4A, st. th.');
  assert.throws(() => parseCommand(message('apply')));
  assert.throws(() => parseCommand(message('apply 9')));
  assert.equal(parseCommand(message('Eksempelvej 12, 2500 Valby')).kind, 'apply');
  assert.throws(() => parseCommand({ ...message(), reply_to_message: undefined }));
});

test('auth binds chat, sender and original bot, including group chats', () => {
  assert.equal(authorize(message(), config), true);
  for (const m of [
    { ...message(), from: { id: 8 } }, { ...message(), chat: { id: 8 } },
    { ...message(), from: { id: 7, is_bot: true } },
    { ...message(), reply_to_message: { from: { id: 88 } } },
  ]) assert.equal(authorize(m, config), false);
  assert.equal(authorize({ ...message(), chat: { id: -100123 } }, { ...config, chatId: '-100123' }), true);
});

test('dedup key tolerates case and punctuation differences', () => {
  assert.equal(addressKey(parseAddress('Eksempelvej 12, 2. tv., 2500 Valby')), addressKey(parseAddress('eksempelvej 12 2 tv, 2500 valby')));
});

test('profile validation catches missing fields and invalid dates', () => {
  assert.equal(loadProfile(JSON.stringify(profile)).phone, '+4512345678');
  assert.throws(() => loadProfile('{}'));
  assert.throws(() => loadProfile('{broken'));
  assert.throws(() => loadProfile(JSON.stringify({ ...profile, birth_date: '31/02/2000' })));
});

test('only the actual API success field constitutes confirmed receipt', () => {
  assert.equal(confirmedResponse(200, { data: { success: true } }), true);
  for (const [status, body] of [[200, {}], [200, { succeeded: true }], [200, { data: { success: false } }], [500, { data: { success: true } }]]) assert.equal(confirmedResponse(status, body), false);
});

test('durable reservation precedes submission and duplicate replies cannot apply again', async () => {
  const h = harness(); let calls = 0;
  h.apply = async (_a, _p, options) => { calls++; await options.beforeSubmit(); assert.equal(Object.values(h.saves[0].applications)[0].status, 'pending'); return { status: 'submitted' }; };
  await handleUpdate({ message: message() }, h);
  await handleUpdate({ message: message() }, h);
  assert.equal(calls, 1);
  assert.equal(Object.values(h.store.state.applications)[0].status, 'submitted');
  assert.match(h.sent.at(-1), /Blocked duplicate/);
});

test('interruption after reservation blocks resubmission', async () => {
  const h = harness(); let calls = 0;
  h.apply = async (_a, _p, options) => { calls++; await options.beforeSubmit(); throw new Error('Connection lost after click'); };
  await handleUpdate({ message: message() }, h);
  await handleUpdate({ message: message() }, h);
  assert.equal(calls, 1);
  assert.equal(Object.values(h.store.state.applications)[0].status, 'unknown');
});

test('reservation write failure propagates before submission', async () => {
  const h = harness(); let clicked = false;
  h.store.save = async () => { throw new Error('API unavailable'); };
  h.apply = async (_a, _p, options) => { await options.beforeSubmit(); clicked = true; return { status: 'submitted' }; };
  await assert.rejects(handleUpdate({ message: message() }, h), /reservation failed/);
  assert.equal(clicked, false);
});

test('preview leaves no application reservation so live retry remains possible', async () => {
  const h = harness(); h.config = { ...config, dryRun: true };
  h.apply = async (_a, _p, options) => { assert.equal(options.dryRun, true); return { status: 'preview' }; };
  await handleUpdate({ message: message() }, h);
  assert.deepEqual(h.store.state.applications, {});
  assert.match(h.sent.at(-1), /nothing was submitted/);
});

test('unauthorized and stale updates cannot submit', async () => {
  const h = harness(); h.apply = async () => { assert.fail('must not submit'); };
  await handleUpdate({ message: { ...message(), from: { id: 8 } } }, h);
  assert.equal(h.sent.length, 0);
  await handleUpdate({ message: { ...message(), date: 1 } }, h);
  assert.match(h.sent[0], /too old/);
});

test('preparation failures do not reserve or falsely report success', async () => {
  const h = harness(); h.apply = async () => { throw new Error('field changed'); };
  await handleUpdate({ message: message() }, h);
  assert.deepEqual(h.store.state.applications, {});
  assert.match(h.sent.at(-1), /no submit click/);
});

test('ledger survives restart and corrupted state fails closed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'housing-test-'));
  try {
    const filename = path.join(dir, 'state.json');
    const store = new LocalState(filename); await store.load();
    const key = addressKey(parseAddress('Eksempelvej 12, 2500 Valby'));
    store.state.applications[key] = { status: 'pending' }; store.state.offset = 42; await store.save();
    const next = new LocalState(filename); await next.load();
    assert.equal(next.state.offset, 42); assert.equal(next.state.applications[key].status, 'pending');
    fs.writeFileSync(filename, '{}'); await assert.rejects(new LocalState(filename).load());
    assert.throws(() => validateState({ version: 1, offset: 1, acceptAfter: 1, applications: { wrong: { status: 'submitted' } } }));
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('GitHub ledger uses SHA compare-and-swap and propagates conflict', async () => {
  const h = harness(); const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'GET') return { ok: true, json: async () => ({ sha: 'old-sha', content: Buffer.from(JSON.stringify(h.store.state)).toString('base64') }) };
    return { ok: false, status: 409, json: async () => ({}) };
  };
  const store = new GitHubState({ repository: 'test/repo', token: 'fake', fetchImpl });
  await store.load(); await assert.rejects(store.save(), /409/);
  assert.equal(JSON.parse(calls[1].options.body).sha, 'old-sha');
});

test('actual watcher notifications remain parseable after Telegram chunking', () => {
  const listings = Array.from({ length: 6 }, (_, i) => ({ title: `Eksempelvej ${i + 1}, 2500 Valby`, postcode: 2500, city: 'Valby', url: LISTINGS_URL, text: 'Husleje '.repeat(130) }));
  const chunks = splitMessage(buildListingsMessage('Housing update', listings), 3800);
  for (const chunk of chunks) {
    const first = chunk.match(/^(\d+)\. /m);
    if (!first) continue;
    const m = message(`apply ${first[1]}`); m.reply_to_message.text = chunk;
    assert.equal(parseCommand(m).address.street, `Eksempelvej ${first[1]}`);
  }
});
