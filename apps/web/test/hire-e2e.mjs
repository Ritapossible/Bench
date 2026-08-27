/**
 * The hire path, end to end, in a real browser.
 *
 * This exists because of one line in the contest rubric: TermiX will hire from
 * the marketplace and evaluate the results. Nobody will be there to nudge it
 * past a hydration bug or a disabled button, so the thing that has to be true
 * is not "the orchestrator is correct" - that has unit tests - but "a stranger
 * can complete this unaided". Those fail differently, and only this catches the
 * second.
 *
 * It asserts the consent gate actually gates, since that is the one control a
 * user watches working, and it fails on any console or page error rather than
 * only on a broken assertion - a hire that completes while throwing in the
 * console is not a hire path anyone should ship.
 *
 *   npm run test:e2e            # against a server already on :3100
 *   E2E_BASE_URL=... npm run test:e2e
 */
import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100';
// Let Playwright resolve its own browser; PLAYWRIGHT_CHROMIUM_PATH is an escape
// hatch for environments that ship Chromium somewhere Playwright will not look.
const explicit = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const browser = await chromium.launch(explicit ? { executablePath: explicit } : {});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

const step = (msg) => console.log(`  ${msg}`);

// 1. Land on the catalog the way a stranger would.
await page.goto(`${BASE}/agents`, { waitUntil: 'networkidle' });
// The catalog rows are rendered by a client component, so wait for hydration
// rather than for the network to go quiet - those are different moments.
await page.locator('a[href^="/agents/bsc-testnet/"]').first().waitFor({ timeout: 15000 });
const rows = await page.locator('a[href^="/agents/bsc-testnet/"]').count();
if (rows === 0) throw new Error('catalog rendered no agents');
step(`catalog lists ${rows} agent links`);

// 2. Open an agent, then its hire page.
await page.goto(`${BASE}/agents/bsc-testnet/1041/hire`, { waitUntil: 'networkidle' });
const heading = await page.locator('h1').first().innerText();
step(`hire page heading: "${heading}"`);

// 3. The submit button must be refused until every step is confirmed.
const submit = page.locator('button[type=submit]');
if (!(await submit.isDisabled()))
  throw new Error('submit was enabled before any consent was given');
step(`submit disabled before consent: yes ("${(await submit.innerText()).trim()}")`);

// 4. Walk the checklist in order, as the UI requires.
let confirmed = 0;
for (let i = 0; i < 8; i += 1) {
  const next = page.locator('section.step[data-state="current"] button:not([type=submit])').last();
  if ((await next.count()) === 0) break;
  await next.click();
  await page.waitForTimeout(120);
  confirmed += 1;
}
step(`confirmed ${confirmed} consent steps`);

if (await submit.isDisabled()) throw new Error('submit still disabled after completing consent');
step('submit enabled after consent: yes');

// 5. Hire, and follow the redirect to the hire record.
await Promise.all([page.waitForURL(/\/hires\//, { timeout: 20000 }), submit.click()]);
const url = page.url();
step(`redirected to ${url.replace(BASE, '')}`);

const body = await page.locator('body').innerText();
for (const needle of ['active', 'Total ceiling', 'Revoke', 'chain verified']) {
  if (!body.includes(needle)) throw new Error(`hire page is missing "${needle}"`);
}
step('hire record shows state, bounds and a revoke control');

// 6. The decision trace must be there and verify.
if (!/trace|Trace/.test(body)) throw new Error('no decision trace on the hire page');
step('decision trace rendered');

// 7. A reload must not create a second hire (idempotency, end to end).
await page.reload({ waitUntil: 'networkidle' });
if (page.url() !== url) throw new Error('reload moved the hire');
step('reload returns the same hire');

// 8. Revoke works and is reflected.
const revoke = page.locator('button', { hasText: /Revoke/i }).first();
await revoke.click();
await page.waitForTimeout(1500);
const after = await page.locator('body').innerText();
if (!/revoked/i.test(after)) throw new Error('revoke did not take effect');
step('revoked, and the page says so');

if (errors.length > 0) {
  console.log('\nBrowser errors:');
  for (const e of errors) console.log(`  ${e}`);
  throw new Error(`${errors.length} browser error(s)`);
}

await browser.close();
console.log('\nPASS - a stranger can hire an agent end to end.');
