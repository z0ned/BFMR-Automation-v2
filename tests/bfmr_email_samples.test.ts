import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBfmrEmail } from '../src/services/bfmrEmailLinks';
import { bfmrEmailSampleFixtures } from './fixtures/bfmr_email_samples';

test('sanitized BFMR sample templates follow the single-deal MVP intake boundary', () => {
  for (const fixture of bfmrEmailSampleFixtures) {
    const parsed = parseBfmrEmail({
      id: `fixture-${fixture.sourceCategory}`,
      messageId: `synthetic-${fixture.sourceCategory}`,
      sender: 'fixture@buyformeretail.example',
      subject: fixture.subject,
      body: fixture.body,
      receivedAt: '2026-10-11T12:00:00.000Z',
    });

    assert.deepEqual({
      isSingleDeal: parsed.isSingleDeal,
      isMultiDeal: parsed.isMultiDeal,
      isAdditionalSlotNotice: parsed.isAdditionalSlotNotice,
    }, fixture.expected, fixture.name);
  }
});

test('the same NEW DEAL UPDATE subject uses the body to distinguish an announcement from a reservation update', () => {
  const [announcement, update] = bfmrEmailSampleFixtures.filter(fixture =>
    fixture.subject === 'NEW DEAL UPDATE - SAMPLE PRODUCT');
  assert.ok(announcement && update);

  const parse = (fixture: typeof announcement) => parseBfmrEmail({
    messageId: `synthetic-${fixture.sourceCategory}`,
    sender: 'fixture@buyformeretail.example',
    subject: fixture.subject,
    body: fixture.body,
  });

  assert.equal(parse(announcement).isSingleDeal, true);
  assert.equal(parse(update).isSingleDeal, false);
  assert.equal(parse(update).isAdditionalSlotNotice, true);
});

test('changing only the subject never changes an email body interpretation', () => {
  for (const fixture of bfmrEmailSampleFixtures) {
    const parse = (subject: string) => parseBfmrEmail({
      messageId: `synthetic-${fixture.sourceCategory}`,
      sender: 'fixture@buyformeretail.example',
      subject,
      body: fixture.body,
    });
    const expected = parse(fixture.subject);
    const changedSubject = parse('NEW DEAL | ALL DEALS | PAYMENT SENT');
    assert.deepEqual({
      isSingleDeal: changedSubject.isSingleDeal,
      isMultiDeal: changedSubject.isMultiDeal,
      isAdditionalSlotNotice: changedSubject.isAdditionalSlotNotice,
      dealUrl: changedSubject.dealUrl,
      canonicalDealId: changedSubject.canonicalDealId,
      dealTitle: changedSubject.dealTitle,
      retailer: changedSubject.retailer,
      isBundle: changedSubject.isBundle,
    }, {
      isSingleDeal: expected.isSingleDeal,
      isMultiDeal: expected.isMultiDeal,
      isAdditionalSlotNotice: expected.isAdditionalSlotNotice,
      dealUrl: expected.dealUrl,
      canonicalDealId: expected.canonicalDealId,
      dealTitle: expected.dealTitle,
      retailer: expected.retailer,
      isBundle: expected.isBundle,
    }, fixture.name);
  }
});
