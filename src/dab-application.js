const { chromium } = require('playwright');
const FORM_URL = 'https://dab-lejerbo.dk/boligsoegende/tidsbegraensede-boliger/blanket-til-tidsbegraenset-bolig/';
const SUBMIT_PATH = '/api/forms/SubmitForm';

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
  await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const form = page.locator('form').filter({ has: page.getByText('Tidsbegrænsede lejemål', { exact: true }) });
  await form.waitFor({ state: 'visible', timeout: 45000 });
  const cookie = page.getByRole('button', { name: 'Accepter kun de nødvendige cookies', exact: true });
  if (await cookie.isVisible()) await cookie.click();
  if (await form.count() !== 1) throw new Error('Application form structure changed.');

  const countries = form.locator('bex-autocomplete[formcontrolname="country"]');
  if (await countries.count() !== 2) throw new Error('Address structure changed.');
  for (const country of await countries.all()) {
    if (!/Danmark/.test(await country.innerText())) throw new Error('Country is not Danmark; fill this application manually.');
  }
  const fields = [
    ['zipCode', [address.postcode, profile.current_postcode]],
    ['city', [address.city, profile.current_city]],
    ['streetAndLocation', [address.street, profile.current_street]],
  ];
  for (const [control, values] of fields) {
    const inputs = form.locator(`bex-input[formcontrolname="${control}"] input`);
    if (await inputs.count() !== 2) throw new Error('Address fields changed.');
    for (let i = 0; i < 2; i++) await inputs.nth(i).fill(values[i]);
  }
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
  await form.locator('input[type="tel"]').press('Tab');
  if (await page.locator('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],.g-recaptcha').count()) {
    throw new Error('CAPTCHA requires a manual application.');
  }
  // The live component uses novalidate and renders pattern="null" on ordinary
  // inputs. Native checkValidity() therefore rejects legitimate text: use the
  // Angular form/control validity which the site's own Send action uses.
  if (await form.locator('bex-input.ng-invalid,bex-datepicker.ng-invalid,bex-autocomplete.ng-invalid').count() ||
      !(await form.evaluate(el => el.classList.contains('ng-valid') && !el.classList.contains('ng-invalid')))) {
    throw new Error('The site rejected one or more fields; check your applicant settings.');
  }
  return page.getByRole('button', { name: 'Send', exact: true }).filter({ visible: true });
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

module.exports = { FORM_URL, loadProfile, confirmedResponse, fillApplication, applyForHousing };
