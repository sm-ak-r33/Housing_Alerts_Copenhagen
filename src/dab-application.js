const { chromium } = require('playwright');
const FORM_URL = 'https://dab-lejerbo.dk/boligsoegende/tidsbegraensede-boliger/blanket-til-tidsbegraenset-bolig/';
const SUBMIT_PATH = '/api/forms/SubmitForm';

// Never expose raw Playwright errors. City diagnostics include only the relevant
// postcode/city pair in the already-authorized Telegram chat, not logs.
const PREPARATION_MESSAGES = Object.freeze({
  OPEN_FORM: 'The application page or form did not become ready.',
  COUNTRY: 'Could not read the country controls.',
  COUNTRY_STRUCTURE: 'The expected two country controls did not appear within 45 seconds.',
  COUNTRY_NOT_READY: 'The country controls appeared, but their selected values did not load within 45 seconds.',
  COUNTRY_VALUE: 'Both addresses must have Danmark selected.',
  ADDRESS: 'The address fields changed or could not be filled.',
  ADDRESS_SELECTION: 'The address autocomplete could not confirm the exact address.',
  ADDRESS_CHANGED: 'An address field changed unexpectedly during autocomplete.',
  CITY_LOOKUP: 'Postcode lookup did not finish. The site did not autofill and lock the city fields.',
  CITY_MISMATCH: 'The city returned by the site does not match the supplied postcode/city. Check both addresses.',
  APPLICANT: 'An applicant field could not be found or filled.',
  DATE: 'A birth-date field could not be filled or did not retain DD/MM/YYYY.',
  CAPTCHA: 'CAPTCHA requires a manual application.',
  VALIDATION: 'The form did not become valid. Check applicant details and address lookup.',
});
class PreparationError extends Error {
  constructor(code, details = null) {
    super(PREPARATION_MESSAGES[code]);
    this.details = details;
    this.name = 'PreparationError';
    this.code = code;
  }
}
function preparationReason(error) {
  if (!(error instanceof PreparationError)) {
    return '[PREPARATION_FAILED] Browser startup or an unexpected preparation step failed.';
  }
  if (error.code === 'ADDRESS_SELECTION' && error.details) {
    const label = error.details.addressType === 'current' ? 'Your current address (current_street)' : 'The listing address';
    const reason = error.details.reason === 'ambiguous' ? 'Multiple suggestions matched.'
      : error.details.reason === 'selection_invalid' ? 'The selected suggestion did not validate the address group.'
      : 'No exact matching suggestion or valid manual address was accepted before timeout.';
    return `[ADDRESS_SELECTION] ${label}: ${reason} Include the full street, house number, floor and door where applicable.`;
  }
  if (error.code === 'VALIDATION' && error.details) {
    const { formState, problems } = error.details;
    return `[VALIDATION] Form state: ${formState}. ` +
      (problems.length ? `Invalid/pending fields or groups: ${problems.join('; ')}.`
        : 'No invalid visible field was identified; an internal form control may still be invalid.');
  }
  if (['COUNTRY_STRUCTURE', 'COUNTRY_NOT_READY', 'COUNTRY_VALUE'].includes(error.code) && error.details) {
    const { count, selections } = error.details;
    const safe = value => JSON.stringify(String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80));
    return `[${error.code}] ${PREPARATION_MESSAGES[error.code]} ` +
      `Controls found: ${count}. Selected countries (listing, current): ` +
      selections.map(value => safe(value || '(not loaded)')).join(', ') + '.';
  }
  if (error.code === 'CITY_MISMATCH' && error.details) {
    // Keep diagnostics single-line, bounded and restricted to known fields.
    const safe = value => JSON.stringify(String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 100));
    const { addressType, postcode, suppliedCity, siteCity } = error.details;
    const current = addressType === 'current';
    return `[CITY_MISMATCH] ${current ? 'Your current address' : 'The listing address'}: ` +
      `postcode ${safe(postcode)}; supplied city ${safe(suppliedCity)}; site city ${safe(siteCity)}. ` +
      (current
        ? 'Check current_postcode and current_city in DAB_APPLICANT_JSON. If the postcode is correct, use the site city as current_city.'
        : 'Check the postcode and city in your apply reply. If the postcode is correct, use the site city in that reply.');
  }
  return `[${error.code}] ${PREPARATION_MESSAGES[error.code]}`;
}
const normalizeCity = value => value.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('da-DK');
function validateCityMatch(addressType, postcode, suppliedCity, siteCity) {
  if (normalizeCity(siteCity) !== normalizeCity(suppliedCity)) {
    throw new PreparationError('CITY_MISMATCH', { addressType, postcode, suppliedCity, siteCity });
  }
}

// A visible form heading does not mean the custom controls have hydrated.
// Read the selected button only: dropdown options may also contain "Danmark".
async function waitForCountrySelection(readSelections, { timeoutMs = 45000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let selections = [];
  while (true) {
    selections = await readSelections();
    if (selections.length === 2 && selections.every(value =>
      String(value || '').normalize('NFC').trim().toLocaleLowerCase('da-DK') === 'danmark')) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
  const code = selections.length !== 2 ? 'COUNTRY_STRUCTURE'
    : selections.some(value => !String(value || '').trim()) ? 'COUNTRY_NOT_READY' : 'COUNTRY_VALUE';
  throw new PreparationError(code, { count: selections.length, selections: selections.slice(0, 2) });
}

// Preserve token boundaries: "8 7 1" must not match "8 71" or "8 7 11".
const normalizeStreet = value => String(value).normalize('NFC').toLocaleLowerCase('da-DK')
  .replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();

async function resolveAddressSelection(readState, clickOption, street, addressType,
  { timeoutMs = 20000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let selected = false;
  while (true) {
    const state = await readState();
    if (normalizeStreet(state.street) !== normalizeStreet(street)) throw new PreparationError('ADDRESS_CHANGED');
    if (selected) {
      if (state.valid) return;
    } else {
      const matches = state.options.filter(text => normalizeStreet(text) === normalizeStreet(street));
      if (matches.length > 1) throw new PreparationError('ADDRESS_SELECTION', { addressType, reason: 'ambiguous' });
      if (matches.length === 1) {
        // Do not press Enter: if the menu vanished, it could submit the form.
        await clickOption(matches[0]);
        selected = true;
        continue;
      }
      // The site's component explicitly accepts manual input when its search
      // returns zero suggestions, populating its internal street/number fields.
      if (state.options.length === 0 && state.valid) return;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
  throw new PreparationError('ADDRESS_SELECTION', {
    addressType, reason: selected ? 'selection_invalid' : 'no_match',
  });
}

async function fillAddress(form, index, street, addressType) {
  const blocks = form.locator('aws');
  if (await blocks.count() !== 2) throw new PreparationError('ADDRESS');
  const block = blocks.nth(index);
  await block.locator('bex-input[formcontrolname="streetAndLocation"] input').fill(street);
  await resolveAddressSelection(
    () => block.evaluate(el => ({
      street: el.querySelector('bex-input[formcontrolname="streetAndLocation"] input')?.value || '',
      options: [...el.querySelectorAll('[data-address-list] [role="option"]')].map(option => option.innerText.trim()),
      valid: el.firstElementChild?.classList.contains('ng-valid') &&
        !el.firstElementChild.classList.contains('ng-invalid') &&
        !el.firstElementChild.classList.contains('ng-pending'),
    })),
    text => block.getByRole('option', { name: text, exact: true }).click(),
    street, addressType,
  );
}

// Runs in the browser. Return only fixed field names and statuses, never values.
function inspectValidation(el) {
  const problems = [];
  const invalid = node => node?.classList.contains('ng-invalid') || node?.classList.contains('ng-pending');
  const blocks = [...el.querySelectorAll('aws')];
  blocks.forEach((block, index) => {
    if (invalid(block.firstElementChild)) problems.push(index === 0 ? 'listing address group' : 'current address group');
  });
  const names = {
    'Dit navn': 'name', 'Mailadresse': 'email', 'Dit telefonnummer': 'phone',
    'Din fødselsdato': 'birth_date',
    'Navn på evt. samlever, der også skal bo i boligen': 'partner_name',
    'Fødselsdato på evt. samlever, der også skal bo i boligen': 'partner_birth_date',
  };
  for (const node of el.querySelectorAll('bex-input,bex-datepicker,bex-autocomplete')) {
    if (!invalid(node)) continue;
    const control = node.getAttribute('formcontrolname');
    const addressIndex = blocks.findIndex(block => block.contains(node));
    let name;
    if (addressIndex >= 0 && ['zipCode', 'city', 'streetAndLocation'].includes(control)) {
      name = `${addressIndex === 0 ? 'listing' : 'current'} ${control}`;
    } else if (control === 'country') name = 'country';
    else name = names[node.querySelector('label')?.textContent.trim()] || 'unidentified field';
    const input = node.querySelector('input');
    problems.push(name + (input && !input.value.trim() ? ' (empty)' : ' (invalid or pending)'));
  }
  return {
    formState: el.classList.contains('ng-pending') ? 'pending' : el.classList.contains('ng-invalid') ? 'invalid'
      : el.classList.contains('ng-valid') ? 'valid' : 'unknown',
    problems: [...new Set(problems)],
  };
}

function loadProfile(raw) {
  let p;
  try { p = JSON.parse(raw); } catch { throw new Error('DAB_APPLICANT_JSON must be valid JSON.'); }
  for (const key of ['name', 'email', 'phone', 'current_street', 'current_postcode', 'current_city']) {
    if (typeof p?.[key] !== 'string' || !p[key].trim()) throw new Error(`Missing applicant field: ${key}`);
    p[key] = p[key].trim();
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) throw new Error('Invalid applicant email.');
  if (!/^[1-9]\d{3}$/.test(p.current_postcode)) throw new Error('Current postcode must have four digits.');
  p.phone = p.phone.replace(/[ ()-]/g, '');
  if (!/^\+?\d{8,10}$/.test(p.phone)) throw new Error('Phone must contain 8–10 digits, optionally prefixed by +.');
  if (p.current_country && p.current_country !== 'Danmark') throw new Error('This adapter currently supports a Danish current address only.');
  for (const key of ['birth_date', 'partner_birth_date']) {
    if (!p[key]) continue;
    if (typeof p[key] !== 'string' || !/^\d{2}\/\d{2}\/\d{4}$/.test(p[key])) throw new Error(`${key} must use DD/MM/YYYY.`);
    const [d, m, y] = p[key].split('/').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d || date > new Date()) throw new Error(`Invalid ${key}.`);
  }
  if (p.partner_name != null && typeof p.partner_name !== 'string') throw new Error('partner_name must be a string.');
  return p;
}

function confirmedResponse(status, body) {
  // Verified against the site's published form component: it checks response.data.success.
  return status >= 200 && status < 300 && body?.data?.success === true;
}

async function fillApplication(page, address, profile) {
  let stage = 'OPEN_FORM';
  try {
    await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const form = page.locator('form').filter({ has: page.getByText('Tidsbegrænsede lejemål', { exact: true }) });
    await form.waitFor({ state: 'visible', timeout: 45000 });
    const cookie = page.getByRole('button', { name: 'Accepter kun de nødvendige cookies', exact: true });
    if (await cookie.isVisible()) await cookie.click();
    if (await form.count() !== 1) throw new Error('Application form structure changed.');

    stage = 'COUNTRY';
    await waitForCountrySelection(() =>
      form.locator('bex-autocomplete[formcontrolname="country"]').evaluateAll(elements =>
        elements.map(element => element.querySelector('button[aria-haspopup="listbox"]')?.innerText?.trim() || '')
      )
    );
    stage = 'ADDRESS';
    const postcodes = form.locator('bex-input[formcontrolname="zipCode"] input');
    const cities = form.locator('bex-input[formcontrolname="city"] input');
    const streets = form.locator('bex-input[formcontrolname="streetAndLocation"] input');
    for (const inputs of [postcodes, cities, streets]) {
      if (await inputs.count() !== 2) throw new PreparationError('ADDRESS');
    }
    await postcodes.nth(0).fill(address.postcode);
    await postcodes.nth(1).fill(profile.current_postcode);
    await postcodes.nth(1).press('Tab');

    // Denmark's postcode lookup fills and disables city asynchronously.
    // Never race it by typing into city, or silently accept a different city.
    stage = 'CITY_LOOKUP';
    await page.waitForFunction(el => {
      const inputs = [...el.querySelectorAll('bex-input[formcontrolname="city"] input')];
      return inputs.length === 2 && inputs.every(input => input.disabled && input.value.trim());
    }, await form.elementHandle(), { timeout: 20000 });
    const expectedAddresses = [
      { type: 'listing', postcode: address.postcode, city: address.city },
      { type: 'current', postcode: profile.current_postcode, city: profile.current_city },
    ];
    for (let i = 0; i < 2; i++) {
      const expected = expectedAddresses[i];
      validateCityMatch(expected.type, expected.postcode, expected.city, await cities.nth(i).inputValue());
    }
    stage = 'ADDRESS';
    await fillAddress(form, 0, address.street, 'listing');
    await fillAddress(form, 1, profile.current_street, 'current');
    // Selection must not change the requested postcode/city.
    for (let i = 0; i < 2; i++) {
      if (await postcodes.nth(i).inputValue() !== expectedAddresses[i].postcode) throw new PreparationError('ADDRESS_CHANGED');
      validateCityMatch(expectedAddresses[i].type, expectedAddresses[i].postcode, expectedAddresses[i].city, await cities.nth(i).inputValue());
    }
    stage = 'APPLICANT';
    // Labels are visually present but some inputs lack HTML label associations.
    for (const [label, value] of [
      [/^Dit navn\*/, profile.name], [/^Mailadresse\*/, profile.email],
      [/^Dit telefonnummer\*/, profile.phone],
      [/^Navn på evt\. samlever, der også skal bo i boligen$/, profile.partner_name || ''],
    ]) {
      const field = form.locator('bex-input').filter({ hasText: label }).locator('input');
      if (await field.count() !== 1) throw new Error('Applicant fields changed.');
      await field.fill(value);
    }
    stage = 'DATE';
    for (const [label, value] of [
      [/^Din fødselsdato$/, profile.birth_date],
      [/^Fødselsdato på evt\. samlever, der også skal bo i boligen$/, profile.partner_birth_date],
    ]) {
      if (!value) continue;
      const field = form.locator('bex-datepicker').filter({ hasText: label }).locator('input');
      await field.fill(value);
      await field.press('Tab');
      if (await field.inputValue() !== value) throw new Error('Date input was not accepted.');
    }
    stage = 'APPLICANT';
    await form.locator('input[type="tel"]').press('Tab');
    if (await page.locator('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],.g-recaptcha').count()) {
      throw new PreparationError('CAPTCHA');
    }
    // The live component uses novalidate and renders pattern="null" on ordinary
    // inputs. Native checkValidity() therefore rejects legitimate text: use the
    // Angular form/control validity which the site's own Send action uses.
    stage = 'VALIDATION';
    try {
      await page.waitForFunction(el =>
        el.classList.contains('ng-valid') &&
        !el.classList.contains('ng-invalid') &&
        !el.classList.contains('ng-pending') &&
        !el.querySelector('.ng-invalid,.ng-pending'),
        await form.elementHandle(), { timeout: 20000 });
    } catch {
      const details = await form.evaluate(inspectValidation).catch(() => null);
      throw new PreparationError('VALIDATION', details);
    }
    return page.getByRole('button', { name: 'Send', exact: true }).filter({ visible: true });
  } catch (error) {
    if (error instanceof PreparationError) throw error;
    throw new PreparationError(stage);
  }
}

async function applyForHousing(address, profile, { dryRun = true, beforeSubmit = async () => {}, launch = () => chromium.launch({ headless: true }) } = {}) {
  const browser = await launch();
  try {
    const context = await browser.newContext({ locale: 'da-DK', serviceWorkers: 'block' });
    // In preview mode, block submission at the network boundary too.
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (dryRun && request.method() !== 'GET' && /\/SubmitForm\/?$/i.test(url.pathname)) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const send = await fillApplication(page, address, profile);
    if (await send.count() !== 1 || !(await send.isEnabled())) throw new Error('Send button unavailable.');
    if (dryRun) return { status: 'preview' };
    // The durable reservation MUST succeed before the irreversible click.
    await beforeSubmit();
    try {
      const responsePromise = page.waitForResponse(r => {
        const u = new URL(r.url());
        return u.origin === new URL(FORM_URL).origin && u.pathname.toLowerCase() === SUBMIT_PATH.toLowerCase() && r.request().method() === 'POST';
      }, { timeout: 30000 }).catch(() => null);
      await send.click();
      const response = await responsePromise;
      if (!response) return { status: 'unknown' };
      const body = await response.json().catch(() => null);
      return { status: confirmedResponse(response.status(), body) ? 'submitted' : 'unknown' };
    } catch {
      // Even a click timeout can happen after the server accepted the form.
      return { status: 'unknown' };
    }
  } finally { await browser.close().catch(() => {}); }
}

module.exports = { normalizeStreet, resolveAddressSelection, inspectValidation, fillAddress, waitForCountrySelection, PreparationError, preparationReason, validateCityMatch, FORM_URL, loadProfile, confirmedResponse, fillApplication, applyForHousing };
