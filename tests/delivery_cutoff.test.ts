import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAmazonDeliveryEstimate,
  evaluateDeliveryCutoff,
  calendarDaysBetween,
  getCalendarDateNY,
  BFMR_OPERATIONAL_TIMEZONE,
  type DeliveryEstimate,
} from '../src/services/amazonEvaluation';

test('parseAmazonDeliveryEstimate handles explicitly absent and pending phrases', () => {
  const absentSamples = [
    "We'll email you when available",
    'We’ll email you when available.',
    'Delivery date pending',
    'Temporarily out of stock.',
    'Order now and we’ll deliver when available',
    'Usually ships within 1 to 2 months',
    'delivery date to be determined',
  ];

  for (const text of absentSamples) {
    const parsed = parseAmazonDeliveryEstimate(text);
    assert.equal(parsed.type, 'ABSENT', `Expected ABSENT for "${text}", got ${parsed.type}`);
    assert.equal(parsed.rawText, text.trim());
  }
});

test('parseAmazonDeliveryEstimate handles relative dates: today and tomorrow', () => {
  const baseDate = new Date('2026-10-22T12:00:00Z');

  const todayParsed = parseAmazonDeliveryEstimate('FREE Delivery Today', baseDate);
  assert.equal(todayParsed.type, 'KNOWN');
  assert.equal(getCalendarDateNY(todayParsed.latestDate!), '2026-10-22');

  const tomorrowParsed = parseAmazonDeliveryEstimate('FREE delivery Tomorrow', baseDate);
  assert.equal(tomorrowParsed.type, 'KNOWN');
  assert.equal(getCalendarDateNY(tomorrowParsed.latestDate!), '2026-10-23');

  const tomorrowNamed = parseAmazonDeliveryEstimate('Arriving tomorrow, Oct 23', baseDate);
  assert.equal(tomorrowNamed.type, 'KNOWN');
  assert.equal(getCalendarDateNY(tomorrowNamed.latestDate!), '2026-10-23');
});

test('parseAmazonDeliveryEstimate extracts single calendar dates', () => {
  const baseDate = new Date('2026-10-22T12:00:00Z');

  const sample1 = parseAmazonDeliveryEstimate('FREE Delivery Tuesday, Nov 4', baseDate);
  assert.equal(sample1.type, 'KNOWN');
  assert.equal(getCalendarDateNY(sample1.latestDate!), '2026-11-04');

  const sample2 = parseAmazonDeliveryEstimate('Delivery: November 5, 2026', baseDate);
  assert.equal(sample2.type, 'KNOWN');
  assert.equal(getCalendarDateNY(sample2.latestDate!), '2026-11-05');

  const sample3 = parseAmazonDeliveryEstimate('Get it as soon as Friday, Oct 30', baseDate);
  assert.equal(sample3.type, 'KNOWN');
  assert.equal(getCalendarDateNY(sample3.latestDate!), '2026-10-30');
});

test('parseAmazonDeliveryEstimate extracts multi-day ranges and identifies latest date', () => {
  const baseDate = new Date('2026-10-22T12:00:00Z');

  // Same month range: Nov 12 - 18
  const sameMonth = parseAmazonDeliveryEstimate('FREE delivery Nov 12 - 18', baseDate);
  assert.equal(sameMonth.type, 'KNOWN');
  assert.equal(getCalendarDateNY(sameMonth.earliestDate!), '2026-11-12');
  assert.equal(getCalendarDateNY(sameMonth.latestDate!), '2026-11-18');

  // Cross-month range: Oct 28 - Nov 2
  const crossMonth = parseAmazonDeliveryEstimate('Delivery Oct 28 - Nov 2', baseDate);
  assert.equal(crossMonth.type, 'KNOWN');
  assert.equal(getCalendarDateNY(crossMonth.earliestDate!), '2026-10-28');
  assert.equal(getCalendarDateNY(crossMonth.latestDate!), '2026-11-02');

  // Year boundary range: Dec 28 - Jan 4
  const decDate = new Date('2026-12-20T12:00:00Z');
  const yearBoundary = parseAmazonDeliveryEstimate('Arriving Dec 28 - Jan 4', decDate);
  assert.equal(yearBoundary.type, 'KNOWN');
  assert.equal(getCalendarDateNY(yearBoundary.earliestDate!), '2026-12-28');
  assert.equal(getCalendarDateNY(yearBoundary.latestDate!), '2027-01-04');
});

test('parseAmazonDeliveryEstimate returns UNKNOWN for invalid or unparseable input', () => {
  assert.equal(parseAmazonDeliveryEstimate('').type, 'UNKNOWN');
  assert.equal(parseAmazonDeliveryEstimate('Special Prime Member Savings').type, 'UNKNOWN');
  assert.equal(parseAmazonDeliveryEstimate('In stock on Tuesday').type, 'UNKNOWN');
});

test('calendarDaysBetween accurately calculates America/New_York day differences', () => {
  const orderDate = new Date('2026-10-22T15:00:00-04:00'); // 3 PM EDT

  // Same day
  assert.equal(calendarDaysBetween(orderDate, new Date('2026-10-22T23:59:59-04:00')), 0);

  // Next day
  assert.equal(calendarDaysBetween(orderDate, new Date('2026-10-23T08:00:00-04:00')), 1);

  // Exactly 14 days later (Nov 5)
  assert.equal(calendarDaysBetween(orderDate, new Date('2026-11-05T12:00:00-05:00')), 14);

  // 15 days later (Nov 6)
  assert.equal(calendarDaysBetween(orderDate, new Date('2026-11-06T12:00:00-05:00')), 15);
});

test('calendarDaysBetween handles daylight saving time transitions without hour skew', () => {
  // DST Fall Back in US is Sunday, Nov 1, 2026
  const beforeDST = new Date('2026-10-31T12:00:00-04:00');
  const afterDST = new Date('2026-11-02T12:00:00-05:00');
  // Calendar days between Oct 31 and Nov 2 is exactly 2 days
  assert.equal(calendarDaysBetween(beforeDST, afterDST), 2);
});

test('evaluateDeliveryCutoff enforces <= 14 calendar days strictly', () => {
  const orderDate = new Date('2026-10-22T14:00:00Z');

  // Boundary: Day 13 -> PASS
  const day13: DeliveryEstimate = {
    type: 'KNOWN',
    rawText: 'Nov 4',
    latestDate: new Date('2026-11-04T12:00:00Z'),
  };
  const res13 = evaluateDeliveryCutoff(day13, orderDate);
  assert.equal(res13.status, 'PASS');
  assert.equal(res13.eligible, true);
  assert.equal(res13.calendarDays, 13);

  // Boundary: Day 14 (exactly 14 days) -> PASS
  const day14: DeliveryEstimate = {
    type: 'KNOWN',
    rawText: 'Nov 5',
    latestDate: new Date('2026-11-05T12:00:00Z'),
  };
  const res14 = evaluateDeliveryCutoff(day14, orderDate);
  assert.equal(res14.status, 'PASS');
  assert.equal(res14.eligible, true);
  assert.equal(res14.calendarDays, 14);

  // Boundary: Day 15 (1 day over limit) -> REJECT
  const day15: DeliveryEstimate = {
    type: 'KNOWN',
    rawText: 'Nov 6',
    latestDate: new Date('2026-11-06T12:00:00Z'),
  };
  const res15 = evaluateDeliveryCutoff(day15, orderDate);
  assert.equal(res15.status, 'REJECT');
  assert.equal(res15.eligible, false);
  assert.equal(res15.calendarDays, 15);
  assert.match(res15.reason, /exceeds policy window/);

  // Far late delivery -> REJECT
  const day30: DeliveryEstimate = {
    type: 'KNOWN',
    rawText: 'Nov 21',
    latestDate: new Date('2026-11-21T12:00:00Z'),
  };
  const res30 = evaluateDeliveryCutoff(day30, orderDate);
  assert.equal(res30.status, 'REJECT');
  assert.equal(res30.eligible, false);
});

test('evaluateDeliveryCutoff evaluates range by its latest date', () => {
  const orderDate = new Date('2026-10-22T14:00:00Z');

  // Range starts day 10, ends day 14 -> PASS
  const rangeOk = parseAmazonDeliveryEstimate('Nov 1 - Nov 5', orderDate);
  const resOk = evaluateDeliveryCutoff(rangeOk, orderDate);
  assert.equal(resOk.status, 'PASS');
  assert.equal(resOk.calendarDays, 14);

  // Range starts day 12, ends day 15 -> REJECT
  const rangeLate = parseAmazonDeliveryEstimate('Nov 3 - Nov 6', orderDate);
  const resLate = evaluateDeliveryCutoff(rangeLate, orderDate);
  assert.equal(resLate.status, 'REJECT');
  assert.equal(resLate.calendarDays, 15);
});

test('evaluateDeliveryCutoff permits explicitly ABSENT estimates', () => {
  const orderDate = new Date('2026-10-22T14:00:00Z');
  const absent: DeliveryEstimate = {
    type: 'ABSENT',
    rawText: 'Delivery date pending',
  };
  const res = evaluateDeliveryCutoff(absent, orderDate);
  assert.equal(res.status, 'PASS');
  assert.equal(res.eligible, true);
  assert.match(res.reason, /absent/i);
});

test('evaluateDeliveryCutoff flags UNKNOWN estimates for manual review', () => {
  const orderDate = new Date('2026-10-22T14:00:00Z');
  const unknown: DeliveryEstimate = {
    type: 'UNKNOWN',
    rawText: 'Invalid delivery text format',
  };
  const res = evaluateDeliveryCutoff(unknown, orderDate);
  assert.equal(res.status, 'UNKNOWN');
  assert.equal(res.eligible, false);
  assert.match(res.reason, /manual review required/i);
});
