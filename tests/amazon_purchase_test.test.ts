import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AMAZON_PURCHASE_TEST_PRODUCT,
  amazonProductAsin,
  parseAmazonOrderTotalUsd,
} from '../src/services/amazonCheckoutRehearsal';

test('purchase test is pinned to the user-authorized Amazon item', () => {
  assert.equal(amazonProductAsin(AMAZON_PURCHASE_TEST_PRODUCT), 'B0GTMJF7PV');
});

test('order total parser accepts repeated consistent USD totals and rejects conflicting or non-USD totals', () => {
  assert.equal(parseAmazonOrderTotalUsd('Items: $99.99\nShipping: $0.00\nOrder total: $107.24'), 107.24);
  assert.equal(parseAmazonOrderTotalUsd('Order total\nUS$ 1,234.56'), 1234.56);
  assert.equal(parseAmazonOrderTotalUsd('Order total: $99.99\nOrder total: $99.99'), 99.99);
  assert.equal(parseAmazonOrderTotalUsd('Order total: $99.99\nOrder total: $101.00'), null);
  assert.equal(parseAmazonOrderTotalUsd('Order total: CA$10.00'), null);
  assert.equal(parseAmazonOrderTotalUsd('Order total: CAD $10.00'), null);
  assert.equal(parseAmazonOrderTotalUsd('Order total: £80.00'), null);
  assert.equal(parseAmazonOrderTotalUsd('No total shown'), null);
});
