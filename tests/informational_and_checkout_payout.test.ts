import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIncomingEmail } from '../src/services/emailParser';
import { fetchLiveBfmrDealPayout } from '../src/services/relationalDealTerms';
import { readLockedPurchaseEvidence } from '../src/services/relationalReservations';
import type { RelationalRuntime } from '../src/services/relationalRuntime';

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

test('readLockedPurchaseEvidence calls live BFMR Deal API at checkout and updates reservations.payout_per_item', async () => {
  let updatedReservationPayout: { id: string; payoutPerItemCents: number } | null = null;
  const workflowEvents: any[] = [];

  const mockRuntime = {
    db: {
      withTransaction: async (fn: (tx: any) => Promise<any>) => {
        const mockTx = {
          reservations: {
            findByBfmrId: async (id: string) => ({
              id: 'res-101',
              bfmr_reservation_id: id,
              deal_id: 'deal-202',
              payout_per_item: '139.99', // Old payout rate at creation
              quantity: 1,
            }),
            updatePayout: async (id: string, payoutPerItemCents: number) => {
              updatedReservationPayout = { id, payoutPerItemCents };
              return { id, payout_per_item: (payoutPerItemCents / 100).toFixed(2) };
            },
          },
          deals: {
            findByBfmrId: async (id: string) => ({
              id: 'deal-202',
              bfmr_deal_id: id,
              slug: 'sample-product-a',
              title: 'Sample Product A',
            }),
          },
          evidence: {
            appendWorkflow: async (wf: any) => { workflowEvents.push(wf); },
          },
        };
        return fn(mockTx);
      },
    },
    sync: {
      readLockedPayoutCents: async () => 13999,
    },
  } as unknown as RelationalRuntime;

  const mockReference = {
    dealId: 'deal-202',
    reserveId: 'reserve-303',
    quantity: 1,
    payoutCents: 13999,
  };

  // Mock live payout returning $149.99 (payout increased)
  const mockFetchLivePayout = async (_slug: string) => 14999;
  const mockReadAmazonEvidence = async () => ({
    productUrl: 'https://www.amazon.com/dp/B09V3HN1KC',
    payoutCents: 13999,
  });

  const evidence = await readLockedPurchaseEvidence(mockRuntime, mockReference, {
    fetchLivePayout: mockFetchLivePayout,
    readAmazonEvidence: mockReadAmazonEvidence,
  });

  // Check that the returned evidence contains the fresh live payout price
  assert.equal(evidence.payoutCents, 14999);
  // Check that reservations.payout_per_item was updated in the database
  assert.ok(updatedReservationPayout);
  assert.equal(updatedReservationPayout.payoutPerItemCents, 14999);
  // Check that workflow audit evidence recorded the refresh
  assert.equal(workflowEvents.length, 1);
  assert.equal(workflowEvents[0].actionType, 'CHECKOUT_PAYOUT');
  assert.equal(workflowEvents[0].outcome, 'PAYOUT_REFRESHED');
  assert.equal(workflowEvents[0].evidence.live_payout_cents, 14999);
  assert.equal(workflowEvents[0].evidence.previous_payout_cents, 13999);
});

test('parseIncomingEmail classifies NEW DEAL with above retail as a single actionable deal', () => {
  const raw = {
    messageId: 'gmail-deal-above-retail',
    sender: 'deals@buyformeretail.com',
    subject: 'FW: NEW DEAL - PREPAID GALAXY A17',
    receivedAt: '2026-10-23T10:00:00Z',
    body: `
      <h2>New Deal: Samsung Galaxy A17</h2>
      <p>We posted a new deal! Paying $10 above retail!</p>
      <a href="https://bfmr.com/deals/samsung-galaxy-a17">View deal</a>
      <p>Payout: $159.99</p>
    `,
  };

  const parsed = parseIncomingEmail(raw);

  assert.equal(parsed.isInformationalUpdate, false);
  assert.equal(parsed.isSingleDeal, true);
  assert.equal(parsed.deals.length, 1);
  assert.equal(parsed.deals[0].canonicalDealId, 'samsung-galaxy-a17');
});
