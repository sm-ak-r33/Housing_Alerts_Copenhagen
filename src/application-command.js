const crypto = require('node:crypto');

const LISTINGS_URL = 'https://dab-lejerbo.dk/boligsoegende/tidsbegraensede-boliger/';
const clean = value => String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();

// Deliberately conservative. An unclear scraped title must never become an application.
function parseAddress(value) {
  const text = clean(value);
  const match = text.match(/^([\p{L}][\p{L} .’'\-]{1,79}\s+\d{1,4}[A-Za-zÆØÅæøå]?(?:\s*,?\s*(?:\d{1,3}\.?|st\.?|sal|tv\.?|th\.?|mf\.?|dør|[A-Za-z])){0,6})\s*,\s*([1-9]\d{3})\s+([\p{L}][\p{L} .’'\-]{0,59})$/iu);
  if (!match || /husleje|indskud|udlejningsperiode|rental period|https|\n/i.test(text)) {
    throw new Error('Use a full address, e.g. apply Eksempelvej 12, 2. tv., 2500 Valby.');
  }
  return { street: clean(match[1]), postcode: match[2], city: clean(match[3]) };
}

const addressText = a => `${a.street}, ${a.postcode} ${a.city}`;
function addressKey(address) {
  // One applicant per bot. No contact information is written into repository state.
  const canonical = addressText(address).toLocaleLowerCase('da').replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function listingChoices(text) {
  return [...String(text || '').matchAll(/^(\d+)\. (.+)\r?$/gm)]
    .map(m => ({ number: Number(m[1]), title: m[2].trim() }));
}

function authorize(message, { chatId, allowedUsers, botId }) {
  return message && !message.from?.is_bot &&
    String(message.chat?.id) === String(chatId) &&
    allowedUsers.has(String(message.from?.id)) &&
    (!message.reply_to_message || String(message.reply_to_message.from?.id) === String(botId));
}

function parseCommand(message) {
  const text = clean(message.text);
  if (/^\/?status$/i.test(text)) return { kind: 'status' };
  if (/^\/?(?:start|help)$/i.test(text)) return { kind: 'help' };
  const reply = message.reply_to_message;
  if (!reply || !String(reply.text || '').split(/\s+/).includes(LISTINGS_URL) ||
      !/^Postcode: /m.test(reply.text || '')) {
    throw new Error('Reply directly to a DAB-Lejerbo listing notification to apply.');
  }
  const choices = listingChoices(reply.text);
  const input = text.replace(/^\/?apply(?:\s+|$)/i, '').trim();
  let title;
  if (!input) {
    if (choices.length !== 1) throw new Error('Several listings: reply apply 1 (or another listing number).');
    title = choices[0].title;
  } else if (/^\d+$/.test(input)) {
    const found = choices.filter(c => c.number === Number(input));
    if (found.length !== 1) throw new Error('That number is not unique in the notification you replied to.');
    title = found[0].title;
  } else {
    // A full address typed in reply is itself explicit authorization to apply there.
    title = input;
  }
  return { kind: 'apply', address: parseAddress(title) };
}

module.exports = { LISTINGS_URL, parseAddress, addressText, addressKey, listingChoices, authorize, parseCommand };
