import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseIncomingEmail } from '../src/services/emailParser';
import { isTrustedBfmrDealUrl, isTrustedBfmrDealsListingUrl } from '../src/services/bfmrUrl';

describe('BFMR deal URL allowlist', () => {
  it('distinguishes trusted generic deals listings from detail and untrusted URLs', () => {
    for (const url of ['https://www.bfmr.com/deals?tag=all', 'https://bfmr.com/deals/']) {
      assert.equal(isTrustedBfmrDealsListingUrl(url), true);
      assert.equal(isTrustedBfmrDealUrl(url), false);
    }
    for (const url of [
      'https://bfmr.com/deals/product', 'https://bfmr.com/login', 'https://bfmr.com/account',
      'https://bfmr.com.evil.example/deals?tag=all', 'http://bfmr.com/deals',
      'https://user:pass@bfmr.com/deals', 'https://bfmr.com:444/deals',
    ]) assert.equal(isTrustedBfmrDealsListingUrl(url), false);
  });
  it('accepts an HTTPS deal link on bfmr.com and extracts its deal ID', () => {
    const url = 'https://bfmr.com/deals/headphones-123';
    const parsed = parseIncomingEmail({
      messageId: 'message-bfmr-host-test',
      sender: 'deals@buyformeretail.com',
      subject: 'New Deal: Headphones',
      body: `Deal link: ${url}`,
    });

    assert.equal(isTrustedBfmrDealUrl(url), true);
    assert.equal(parsed.dealUrl, url);
    assert.equal(parsed.canonicalDealId, 'headphones-123');
  });

  it('rejects lookalike hosts, insecure links, and unapproved paths', () => {
    assert.equal(isTrustedBfmrDealUrl('https://bfmr.com.evil.example/deals/item-1'), false);
    assert.equal(isTrustedBfmrDealUrl('http://bfmr.com/deals/item-1'), false);
    assert.equal(isTrustedBfmrDealUrl('https://bfmr.com/account/login'), false);

    const parsed = parseIncomingEmail({
      messageId: 'message-lookalike-host-test',
      sender: 'deals@buyformeretail.com',
      subject: 'New Deal: Fake offer',
      body: 'Deal link: https://bfmr.com.evil.example/deals/fake-item',
    });
    assert.equal(parsed.dealUrl, undefined);
    assert.equal(parsed.canonicalDealId, undefined);
  });

  it('accepts canonical BFMR deal-detail paths but rejects the generic deals listing', () => {
    assert.equal(isTrustedBfmrDealUrl('https://bfmr.com/deals/apple-watch-series-11-46mm-sport-band-m-l-15'), true);
    assert.equal(isTrustedBfmrDealUrl('https://bfmr.com/deals'), false);
  });
});
