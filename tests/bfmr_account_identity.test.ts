import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import { verifyBfmrAccountIdentity } from '../src/services/bfmrAccountIdentity';
let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
test('browser identity requires an exact account field and a unique matching browser/API reservation', async () => {
  const context = await browser.newContext();
  let identity = 'expected@example.org'; let deal = 'D1'; let rid = 'R1'; let duplicate = false;
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body:
    `<span id="identity">${identity}</span><div class="reservation" data-reserve-id="${rid}" data-deal-id="${deal}">Reservation ${rid}</div>${duplicate ? `<div class="reservation" data-reserve-id="${rid}" data-deal-id="${deal}">Reservation ${rid}</div>` : ''}` }));
  const page = await context.newPage(); await page.goto('https://www.bfmr.com/deals/synthetic');
  const config = { BFMR_ACCOUNT_IDENTITY_SELECTOR: '#identity', BFMR_TRACKER_BROWSER_URL: 'https://www.bfmr.com/my-tracker',
    BFMR_ACCOUNT_PROOF_RESERVE_ID: 'R1', BFMR_ACCOUNT_RESERVATION_SELECTOR: '.reservation' };
  const read = async () => [{ reserve_id: 'R1', deal_id: 'D1' }];
  try {
    assert.equal(await verifyBfmrAccountIdentity(page, 'expected@example.org', read, config), true);
    identity = 'wrong@example.org'; assert.equal(await verifyBfmrAccountIdentity(page, 'expected@example.org', read, config), false);
    identity = 'expected@example.org'; deal = 'D2'; assert.equal(await verifyBfmrAccountIdentity(page, identity, read, config), false);
    deal = 'D1'; duplicate = true; assert.equal(await verifyBfmrAccountIdentity(page, identity, read, config), false);
    duplicate = false; rid = 'other'; assert.equal(await verifyBfmrAccountIdentity(page, identity, read, config), false);
    assert.equal(await verifyBfmrAccountIdentity(page, identity, read, {}), false);
    assert.equal(await verifyBfmrAccountIdentity(page, identity, read, { ...config, BFMR_TRACKER_BROWSER_URL: 'https://evil.example/my-tracker' }), false);
  } finally { await context.close(); }
});
