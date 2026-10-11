import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { decodeBfmrEmailDealLink, parseBfmrEmail } from '../src/services/bfmrEmailLinks';

const deal = 'https://bfmr.com/deals/synthetic-airpods';
function trackedPayload(payload: string) {
  return `https://email.mail.buyformeretail.com/c/${deflateSync(payload).toString('base64url')}`;
}
function tracked(destination: string) {
  return trackedPayload(new URLSearchParams({ d: 'synthetic', l: destination, 'recipient-email': 'fixture@example.invalid' }).toString());
}
function parse(body: string, subject = 'Fw: NEW DEAL - FULL RETAIL | AIRPODS PRO 3') {
  return parseBfmrEmail({ messageId: 'synthetic-email', sender: 'fixture@example.invalid', subject, body: `<p>We posted a new deal!</p>${body}` });
}

test('accepts one tracked product among tracked navigation, images and unsubscribe links', () => {
  const result = parse(`<img src="https://assets.example.invalid/banner.png">
    <a href="${tracked(deal)}">Apple AirPods Pro 3 - USB-C Charging Case</a>
    <a href="${tracked('https://bfmr.com/deals')}">Deals</a>
    <a href="${tracked('https://bfmr.com/my-tracker')}">My Tracker</a>
    <a href="${tracked('https://bfmr.com/unsubscribe')}">unsubscribe</a>
    ${tracked(deal)}`);
  assert.equal(result.isSingleDeal, true);
  assert.equal(result.dealUrl, deal);
  assert.equal(result.canonicalDealId, 'synthetic-airpods');
});

test('supports quoted-printable soft wraps and direct/tracked repeated links', () => {
  const link = tracked(deal);
  const wrapped = `${link.slice(0, 80)}=\r\n${link.slice(80)}`;
  const result = parse(`<a href=3D"${wrapped}">Product</a>\n${deal}\nhttps://www.bfmr.com/deals/synthetic-airpods/`);
  assert.equal(result.isSingleDeal, true);
  assert.equal(result.canonicalDealId, 'synthetic-airpods');
});

test('distinct tracked deals or a direct plus different tracked deal are rejected', () => {
  for (const body of [
    `${tracked(deal)} ${tracked('https://bfmr.com/deals/second-product')}`,
    `${deal} ${tracked('https://bfmr.com/deals/second-product')}`,
  ]) {
    const result = parse(body);
    assert.equal(result.isSingleDeal, false);
    assert.equal(result.isMultiDeal, true);
    assert.equal(result.dealUrl, undefined);
  }
});

test('decoding never makes navigation, unsafe destinations or lookalike trackers into deals', () => {
  for (const destination of [
    'https://evil.example/deals/fake', 'http://bfmr.com/deals/fake',
    'https://bfmr.com@evil.example/deals/fake', 'https://user:pass@bfmr.com/deals/fake',
    'https://bfmr.com:444/deals/fake', 'https://bfmr.com/deals', 'https://bfmr.com/unsubscribe',
  ]) assert.equal(decodeBfmrEmailDealLink(tracked(destination)), null);
  for (const value of [
    tracked(deal).replace('email.mail.buyformeretail.com', 'email.mail.buyformeretail.com.evil.example'),
    tracked(deal).replace('https:', 'http:'),
    tracked(deal).replace('/c/', '/other/'),
    `${tracked(deal)}?destination=${encodeURIComponent(deal)}`,
    'https://email.mail.buyformeretail.com/c/not-valid-zlib',
    trackedPayload('l=not-a-url'), trackedPayload(`other=${encodeURIComponent(deal)}`),
    trackedPayload(`l=${encodeURIComponent(deal)}&l=${encodeURIComponent(deal)}`),
    trackedPayload(`l=${encodeURIComponent(deal)}&padding=${'x'.repeat(17000)}`),
    `https://email.mail.buyformeretail.com/c/${'a'.repeat(8193)}`,
  ]) assert.equal(decodeBfmrEmailDealLink(value), null);
});

test('subjects never affect message classification or inferred deal contents', () => {
  const body = `<p>We posted a new deal!</p><p>Retailer: Best Buy</p>${tracked(deal)}`;
  const subjects = ['NEW DEAL', 'PAYMENT SENT', 'ALL DEALS IN STOCK', 'arbitrary header'];
  const interpretations = subjects.map(subject => {
    const result = parseBfmrEmail({
      messageId: 'synthetic-email', sender: 'fixture@example.invalid', subject, body,
    });
    return {
      isSingleDeal: result.isSingleDeal,
      isMultiDeal: result.isMultiDeal,
      isAdditionalSlotNotice: result.isAdditionalSlotNotice,
      dealUrl: result.dealUrl,
      canonicalDealId: result.canonicalDealId,
      dealTitle: result.dealTitle,
      retailer: result.retailer,
      isBundle: result.isBundle,
    };
  });
  assert.ok(interpretations.every(value => JSON.stringify(value) === JSON.stringify(interpretations[0])));
  assert.equal(interpretations[0].isSingleDeal, true);
  assert.equal(interpretations[0].retailer, 'Best Buy');
});

test('a new-deal subject cannot turn an update body into a new-deal trigger', () => {
  const result = parseBfmrEmail({
    messageId: 'synthetic-email', sender: 'fixture@example.invalid',
    subject: 'NEW DEAL', body: `<p>We increased our payout for the following deal.</p>${tracked(deal)}`,
  });
  assert.equal(result.isSingleDeal, false);
});
