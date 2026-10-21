import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { verifyBfmrAccountIdentity } from '../src/services/bfmrAccountIdentity';

const config = {
  BFMR_ACCOUNT_IDENTITY_SELECTOR: '#identity',
  BFMR_TRACKER_BROWSER_URL: 'https://www.bfmr.com/my-tracker',
  BFMR_ACCOUNT_PROOF_RESERVE_ID: 'R1',
  BFMR_ACCOUNT_RESERVATION_SELECTOR: '.reservation',
};

function syntheticPages(events: string[], beforeNavigation: () => void = () => {}) {
  const row = {
    isVisible: async () => true,
    getAttribute: async (name: string) => name === 'data-reserve-id' ? 'R1' : name === 'data-deal-id' ? 'D1' : null,
  };
  const proofPage = {
    goto: async () => { beforeNavigation(); events.push('navigate'); },
    url: () => config.BFMR_TRACKER_BROWSER_URL,
    locator: (selector: string) => selector === '#identity' ? {
      count: async () => 1,
      isVisible: async () => true,
      innerText: async () => 'expected@example.org',
    } : { all: async () => [row] },
    close: async () => { events.push('close-proof'); },
  } as unknown as Page;
  const sourcePage = {
    url: () => 'https://www.bfmr.com/deals/synthetic',
    context: () => ({ newPage: async () => { events.push('create-proof'); return proofPage; } }),
  } as unknown as Page;
  return { sourcePage, proofPage };
}

test('identity proof awaits page preparation before navigating and closes only its proof page', async () => {
  const events: string[] = [];
  let prepared = false;
  const { sourcePage, proofPage } = syntheticPages(events, () => assert.equal(prepared, true));
  const result = await verifyBfmrAccountIdentity(sourcePage, 'expected@example.org',
    async () => [{ reserve_id: 'R1', deal_id: 'D1' }], config, async page => {
      assert.equal(page, proofPage);
      events.push('prepare-start');
      await Promise.resolve();
      prepared = true;
      events.push('prepare-complete');
    });
  assert.equal(result, true);
  assert.deepEqual(events, ['create-proof', 'prepare-start', 'prepare-complete', 'navigate', 'close-proof']);
});

test('failed proof-page preparation blocks navigation and API reads while closing the proof page', async () => {
  const events: string[] = [];
  const { sourcePage } = syntheticPages(events);
  let apiReads = 0;
  const result = await verifyBfmrAccountIdentity(sourcePage, 'expected@example.org',
    async () => { apiReads += 1; return [{ reserve_id: 'R1', deal_id: 'D1' }]; }, config, async () => {
      events.push('prepare-failed');
      throw new Error('Synthetic read-only guard setup rejected');
    });
  assert.equal(result, false);
  assert.equal(apiReads, 0);
  assert.deepEqual(events, ['create-proof', 'prepare-failed', 'close-proof']);
});
