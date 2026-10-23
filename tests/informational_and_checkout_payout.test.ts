import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIncomingEmail } from '../src/services/emailParser';
import { fetchLiveBfmrDealPayout } from '../src/services/relationalDealTerms';

test('parseIncomingEmail classifies payout increase as informational and not a new deal', () => {
  const raw = {
    messageId: 'gmail-info-001',
    sender: 'deals@buyformeretail.com',
    subject: 'PAYOUT INCREASE - ABOVE RETAIL',
    receivedAt: '2026-10-22T17:00:00Z',
    body: `
      <h2>PAYOUT INCREASE</h2>
      <p>We increased our payout for the following deal!</p>
      <a href="https://bfmr.com/deals/sample-product-a">View deal</a>
      <p>Payout Price: $149.99</p>
    `,
  };

  const parsed = parseIncomingEmail(raw);

  assert.equal(parsed.isInformationalUpdate, true);
  assert.equal(parsed.informationalType, 'PAYOUT_INCREASE');
  assert.equal(parsed.isSingleDeal, false);
  assert.equal(parsed.isMultiDeal, false);
  assert.equal(parsed.deals.length, 1);
  assert.equal(parsed.deals[0].canonicalDealId, 'sample-product-a');
});

test('parseIncomingEmail classifies deal deadline / closing alert as informational', () => {
  const raw = {
    messageId: 'gmail-info-002',
    sender: 'deals@buyformeretail.com',
    subject: 'CLOSING - Apple iPad 10th Gen',
    receivedAt: '2026-10-22T17:15:00Z',
    body: `
      <p>Deal Deadline: This deal is closing soon!</p>
      <a href="https://bfmr.com/deals/apple-ipad-10th-gen">View deal</a>
    `,
  };

  const parsed = parseIncomingEmail(raw);

  assert.equal(parsed.isInformationalUpdate, true);
  assert.equal(parsed.informationalType, 'CLOSING');
  assert.equal(parsed.isSingleDeal, false);
  assert.equal(parsed.isMultiDeal, false);
});

test('parseIncomingEmail classifies additional slots as informational and not a new deal', () => {
  const raw = {
    messageId: 'gmail-info-003',
    sender: 'deals@buyformeretail.com',
    subject: 'MORE RESERVATIONS ADDED',
    receivedAt: '2026-10-22T17:30:00Z',
    body: `
      <p>We have added more reservations to this deal!</p>
      <a href="https://bfmr.com/deals/sample-headset">View deal</a>
    `,
  };

  const parsed = parseIncomingEmail(raw);

  assert.equal(parsed.isInformationalUpdate, true);
  assert.equal(parsed.informationalType, 'ADDITIONAL_SLOTS');
  assert.equal(parsed.isSingleDeal, false);
  assert.equal(parsed.isMultiDeal, false);
});

test('fetchLiveBfmrDealPayout fetches latest payout price in cents from BFMR Deal API', async () => {
  const mockFetch = async (url: string | URL | Request) => {
    assert.match(String(url), /\/api\/v2\/deals\/sample-product-a$/);
    return new Response(JSON.stringify({
      deal: {
        deal_id: 'deal-101',
        slug: 'sample-product-a',
        title: 'Sample Product A',
        payout_price: '149.99',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const payoutCents = await fetchLiveBfmrDealPayout('sample-product-a', mockFetch as unknown as typeof fetch);
  assert.equal(payoutCents, 14999);
});

test('current deal payout rejects conflicting aliases and wrong deal identities', async () => {
  const request = (deal: object) => (async () => new Response(JSON.stringify({ deal }), { status: 200 })) as typeof fetch;
  await assert.rejects(fetchLiveBfmrDealPayout('synthetic', request({ deal_id: 'D101', payout: '80.00', payout_price: '95.00' }), 'D101'), /conflicting/);
  await assert.rejects(fetchLiveBfmrDealPayout('synthetic', request({ deal_id: 'D102', payout: '80.00' }), 'D101'), /identity conflicts/);
});
