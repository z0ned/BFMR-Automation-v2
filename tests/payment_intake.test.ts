import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIncomingEmail } from '../src/services/emailParser';
import { recordPaymentByTrackingNumber, type TrackingPaymentNoticeInput } from '../src/services/relationalPayments';
import type { BusinessRepositories } from '../src/db/relationalRepositories';

test('parseIncomingEmail correctly detects and extracts payment emails with Amazon TBA tracking', () => {
  const raw = {
    messageId: 'gmail-pay-001',
    sender: 'payouts@buyformeretail.com',
    subject: 'PAYMENT SENT - ACH Transfer',
    receivedAt: '2026-10-22T15:30:00Z',
    body: `
      <h2>Payment Sent</h2>
      <p>We have sent your payment of $129.99 via ACH.</p>
      <p>Reference: ACH-TR-987654</p>
      <p>Itemized Shipment Details:</p>
      <p>Tracking: TBA309876543210</p>
      <p>Status: Completed</p>
    `,
  };

  const parsed = parseIncomingEmail(raw);

  assert.equal(parsed.isPaymentNotice, true);
  assert.equal(parsed.isSingleDeal, false);
  assert.equal(parsed.isMultiDeal, false);
  assert.ok(parsed.paymentNotice);
  assert.equal(parsed.paymentNotice.amountCents, 12999);
  assert.equal(parsed.paymentNotice.paymentReference, 'ACH-TR-987654');
  assert.equal(parsed.paymentNotice.paidAt, '2026-10-22T15:30:00Z');
  assert.deepEqual(parsed.paymentNotice.trackingNumbers, ['TBA309876543210']);
});

test('parseIncomingEmail extracts multiple carrier tracking numbers (UPS & USPS)', () => {
  const raw = {
    messageId: 'gmail-pay-002',
    sender: 'payouts@buyformeretail.com',
    subject: 'BFMR - Payout Processed',
    receivedAt: '2026-10-22T16:00:00Z',
    body: `
      <p>Your payment of $245.50 has been sent to your bank.</p>
      <p>Tracking Numbers: 1Z9999999999999999 and 9400111899223344556677</p>
    `,
  };

  const parsed = parseIncomingEmail(raw);

  assert.equal(parsed.isPaymentNotice, true);
  assert.ok(parsed.paymentNotice);
  assert.equal(parsed.paymentNotice.amountCents, 24550);
  assert.equal(parsed.paymentNotice.trackingNumbers.includes('1Z9999999999999999'), true);
  assert.equal(parsed.paymentNotice.trackingNumbers.includes('9400111899223344556677'), true);
});

test('recordPaymentByTrackingNumber resolves shipment -> order -> reservation and records reimbursement', async () => {
  let createdReimbursement: any = null;
  let updatedReservationStatus: { id: string; statusId: string } | null = null;
  const workflowEvents: any[] = [];
  const observationEvents: any[] = [];

  const mockTx = {
    shipments: {
      findByTrackingNumber: async (tracking: string) => {
        if (tracking === 'TBA309876543210') {
          return { id: 'ship-101', order_id: 'ord-202', tracking_number: tracking, quantity: 1, shipping_company: 'AMAZON', status_id: '1' };
        }
        return null;
      },
    },
    orders: {
      findById: async (id: string) => {
        if (id === 'ord-202') {
          return { id: 'ord-202', reservation_id: 'res-303', deal_id: 'deal-404', order_id: '114-1234567-8901234', quantity: 1, total_cost: '129.99' };
        }
        return null;
      },
    },
    reservations: {
      findByBfmrId: async (bfmrId: string) => {
        if (bfmrId === 'bfmr-res-303') {
          return { id: 'res-303', bfmr_reservation_id: bfmrId, deal_id: 'deal-404', quantity: 1, expected_payout: '129.99', reservation_status_id: '2' };
        }
        return null;
      },
      findById: async (id: string) => {
        if (id === 'res-303') {
          return { id: 'res-303', bfmr_reservation_id: 'bfmr-res-303', deal_id: 'deal-404', quantity: 1, expected_payout: '129.99', reservation_status_id: '2' };
        }
        return null;
      },
      updateStatus: async (id: string, statusId: string) => {
        updatedReservationStatus = { id, statusId };
        return { id, reservation_status_id: statusId };
      },
    },
    deals: {
      findByBfmrId: async (bfmrId: string) => {
        if (bfmrId === 'bfmr-deal-404') {
          return { id: 'deal-404', bfmr_deal_id: bfmrId, slug: 'airpods-pro', title: 'AirPods Pro' };
        }
        return null;
      },
      findById: async (id: string) => {
        if (id === 'deal-404') {
          return { id: 'deal-404', bfmr_deal_id: 'bfmr-deal-404', slug: 'airpods-pro', title: 'AirPods Pro' };
        }
        return null;
      },
    },
    emails: {
      upsert: async (input: any) => ({ id: 'email-505', ...input }),
    },
    reimbursements: {
      findByReservationId: async (resId: string) => createdReimbursement,
      create: async (input: any) => {
        createdReimbursement = { id: 'reimb-606', reservation_id: input.reservationId, amount: '129.99', ...input };
        return createdReimbursement;
      },
    },
    evidence: {
      appendObservation: async (obs: any) => { observationEvents.push(obs); },
      appendWorkflow: async (wf: any) => { workflowEvents.push(wf); },
    },
  } as unknown as BusinessRepositories;

  const paymentInput: TrackingPaymentNoticeInput = {
    trackingNumber: 'TBA309876543210',
    amountCents: 12999,
    paidAt: '2026-10-22T15:30:00Z',
    paymentReference: 'ACH-TR-987654',
    email: {
      gmailMessageId: 'msg-999',
      subject: 'PAYMENT SENT',
      emailType: 'PAYMENT_SENT',
      receivedAt: '2026-10-22T15:30:00Z',
    },
    sourceSha256: 'abc123def456'.padEnd(64, '0'),
  };

  const result = await recordPaymentByTrackingNumber(mockTx, paymentInput);

  assert.equal(result.status, 'RECORDED');
  assert.equal(result.reservationId, 'res-303');
  assert.equal(result.orderId, 'ord-202');
  assert.ok(createdReimbursement);
  assert.equal(createdReimbursement.reservation_id, 'res-303');
  assert.equal(updatedReservationStatus?.statusId, '3');
  assert.equal(observationEvents.length, 1);
  assert.equal(workflowEvents.length, 1);
});

test('recordPaymentByTrackingNumber is idempotent when re-executed', async () => {
  const existingReimb = {
    id: 'reimb-606',
    reservation_id: 'res-303',
    payment_email_id: 'email-505',
    amount: '129.99',
    paid_at: '2026-10-22T15:30:00Z',
  };

  let createCalls = 0;
  const mockTx = {
    shipments: {
      findByTrackingNumber: async () => ({ id: 'ship-101', order_id: 'ord-202', tracking_number: 'TBA309876543210' }),
    },
    orders: {
      findById: async () => ({ id: 'ord-202', reservation_id: 'res-303', deal_id: 'deal-404' }),
    },
    reservations: {
      findByBfmrId: async () => ({ id: 'res-303', bfmr_reservation_id: 'bfmr-res-303', deal_id: 'deal-404', expected_payout: '129.99', reservation_status_id: '3' }),
      findById: async () => ({ id: 'res-303', bfmr_reservation_id: 'bfmr-res-303', deal_id: 'deal-404', expected_payout: '129.99', reservation_status_id: '3' }),
      updateStatus: async () => {},
    },
    deals: {
      findByBfmrId: async () => ({ id: 'deal-404', bfmr_deal_id: 'bfmr-deal-404' }),
      findById: async () => ({ id: 'deal-404', bfmr_deal_id: 'bfmr-deal-404' }),
    },
    emails: {
      upsert: async (input: any) => ({ id: 'email-505', ...input }),
    },
    reimbursements: {
      findByReservationId: async () => existingReimb,
      create: async () => {
        createCalls++;
        return existingReimb;
      },
    },
    evidence: {
      appendObservation: async () => {},
      appendWorkflow: async () => {},
    },
  } as unknown as BusinessRepositories;

  const paymentInput: TrackingPaymentNoticeInput = {
    trackingNumber: 'TBA309876543210',
    amountCents: 12999,
    paidAt: '2026-10-22T15:30:00Z',
    email: {
      gmailMessageId: 'msg-999',
      subject: 'PAYMENT SENT',
      emailType: 'PAYMENT_SENT',
      receivedAt: '2026-10-22T15:30:00Z',
    },
    sourceSha256: 'abc123def456'.padEnd(64, '0'),
  };

  const result = await recordPaymentByTrackingNumber(mockTx, paymentInput);
  assert.equal(result.status, 'RECORDED');
  assert.equal(result.reimbursement.id, 'reimb-606');
});

test('recordPaymentByTrackingNumber quarantines payments with unmapped tracking numbers', async () => {
  const workflowEvents: any[] = [];
  const mockTx = {
    shipments: {
      findByTrackingNumber: async () => null,
    },
    emails: {
      upsert: async (input: any) => ({ id: 'email-707', ...input }),
    },
    evidence: {
      appendWorkflow: async (wf: any) => { workflowEvents.push(wf); },
    },
  } as unknown as BusinessRepositories;

  const paymentInput: TrackingPaymentNoticeInput = {
    trackingNumber: 'TBA999999999999',
    amountCents: 8999,
    paidAt: '2026-10-22T15:30:00Z',
    email: {
      gmailMessageId: 'msg-unmapped',
      subject: 'PAYMENT SENT',
      emailType: 'PAYMENT_SENT',
      receivedAt: '2026-10-22T15:30:00Z',
    },
    sourceSha256: 'deadbeef1234'.padEnd(64, '0'),
  };

  const result = await recordPaymentByTrackingNumber(mockTx, paymentInput);

  assert.equal(result.status, 'UNRESOLVED_TRACKING');
  assert.equal(result.trackingNumber, 'TBA999999999999');
  assert.equal(workflowEvents.length, 1);
  assert.equal(workflowEvents[0].outcome, 'UNRESOLVED_PAYMENT_TRACKING');
  assert.equal(workflowEvents[0].evidence.reasonCode, 'TRACKING_NUMBER_NOT_FOUND');
});
