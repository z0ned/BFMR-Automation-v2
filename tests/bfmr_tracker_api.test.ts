import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readRecentReservedRows, trackerApiTestHelpers } from '../src/services/bfmrTrackerApi';

describe('BFMR My Tracker reservation matching', () => {
  const dealId = 'apple-ipad-air-8-11-2026-m4-256gb-wifi-3';
  const title = 'Apple iPad Air 11 inch M4 256GB Wi-Fi';

  it('requires an exact deal ID; titles alone cannot establish identity', () => {
    assert.equal(trackerApiTestHelpers.reservationMatchesDeal({
      title,
      status: 'Reserved',
      qty: 1,
    }, dealId, title), false);

    assert.equal(trackerApiTestHelpers.reservationMatchesDeal({
      deal_id: dealId,
      title: 'API title may differ from email subject',
      status: 'Reserved',
      qty: 2,
    }, dealId, title), true);

    assert.equal(trackerApiTestHelpers.reservationMatchesDeal({
      deal_title: 'Apple Watch Series 11 - 46mm - Sport Band - M/L',
      status: 'reserved',
      qty: '1',
    }, 'd-bbsqg', 'Apple Watch Series 11 - 46mm - Sport Band - M/L'), false);
  });

  it('does not treat another product or a non-reserved row as confirmation', () => {
    assert.equal(trackerApiTestHelpers.reservationMatchesDeal({
      title: 'Apple iPad Pro M4 256GB Wi-Fi',
      status: 'Reserved',
      qty: 1,
    }, dealId, title), false);
    assert.equal(trackerApiTestHelpers.reservationMatchesDeal({
      title,
      status: 'Purchased',
      qty: 1,
    }, dealId, title), false);
    assert.equal(trackerApiTestHelpers.reservationMatchesDeal({
      title,
      qty: 1,
    }, dealId, title), false);
  });

  it('preserves the network cause so a failed API read is diagnosable', () => {
    assert.deepEqual(trackerApiTestHelpers.networkFailureDetails({
      message: 'fetch failed',
      cause: { code: 'EAI_AGAIN', message: 'temporary name resolution failure' },
    }), {
      code: 'EAI_AGAIN',
      message: 'temporary name resolution failure',
    });
  });

  it('summarizes response structure without exposing tracker values', () => {
    const shape = trackerApiTestHelpers.summarizePayloadShape({
      message: 'private message value',
      data: {
        my_tracker: [{ deal_title: 'private product title', qty: 1 }],
      },
    });
    assert.deepEqual(shape, {
      message: { type: 'string', length: 21 },
      data: {
        my_tracker: {
          type: 'array',
          length: 1,
          firstItem: { type: 'object', keys: ['deal_title', 'qty'] },
        },
      },
    });
    assert.equal(JSON.stringify(shape).includes('private'), false);
  });

  it('decodes a JSON-encoded my_tracker array but rejects unrecognized strings', () => {
    assert.deepEqual(trackerApiTestHelpers.decodeTrackerRows('[{"qty":1}]'), [{ qty: 1 }]);
    assert.equal(trackerApiTestHelpers.decodeTrackerRows('No data'), null);
    assert.equal(trackerApiTestHelpers.decodeTrackerRows(undefined), null);
  });

  it('parses the documented top-level and observed data-wrapped responses with complete paging', () => {
    assert.deepEqual(trackerApiTestHelpers.parseTrackerPage({
      message: 'Tracker.',
      my_tracker: [],
      paging: { page: 1, pages: 1, total: 0 },
    }, 1), { rows: [], page: 1, pages: 1, total: 0 });

    assert.deepEqual(trackerApiTestHelpers.parseTrackerPage({
      success: true,
      status: 200,
      message: 'Tracker.',
      data: {
        my_tracker: [],
        paging: { page: 1, pages: 1, total: 0 },
      },
    }, 1), { rows: [], page: 1, pages: 1, total: 0 });

    assert.throws(() => trackerApiTestHelpers.parseTrackerPage({
      data: { my_tracker: [], paging: { page: 1, pages: 2, total: 5 } },
    }, 2), /pagination/);
  });

  it('normalizes only a no-record sentinel backed by complete zero-result pagination', () => {
    assert.deepEqual(trackerApiTestHelpers.parseTrackerPage({
      message: 'Tracker.',
      my_tracker: 'No Record Found',
      paging: { page: 1, pages: 1, total: 0 },
    }, 1), { rows: [], page: 1, pages: 1, total: 0 });

    assert.deepEqual(trackerApiTestHelpers.parseTrackerPage({
      message: 'Tracker.',
      my_tracker: 'No Record Found',
      paging: {
        current_page: 1,
        last_page: 1,
        pages: 0,
        total: 0,
        first: 1,
        last: 0,
      },
    }, 1), { rows: [], page: 1, pages: 1, total: 0 });

    assert.throws(() => trackerApiTestHelpers.parseTrackerPage({
      message: 'Tracker.',
      my_tracker: 'Unexpected value',
      paging: { page: 1, pages: 1, total: 0 },
    }, 1), /inconclusive/);
    assert.equal(trackerApiTestHelpers.isNoResultsSentinel('No Record Found'), true);
  });

  it('summarizes string responses without guessing their meaning and reports the paging total', () => {
    const shape = trackerApiTestHelpers.summarizePayloadShape({
      my_tracker: 'No records found',
      paging: { total: 0 },
    }) as Record<string, unknown>;
    assert.deepEqual(shape.my_tracker, {
      type: 'string',
      length: 16,
      recognizedNoResultsSentinel: true,
    });
    assert.deepEqual(shape.paging, { total: 'number', totalValue: 0 });
    assert.equal(JSON.stringify(shape).includes('No records found'), false);
  });

  it('uses the injected transport for every page and rejects incomplete reads', async (t) => {
    const names = ['BFMR_API_KEY', 'BFMR_API_SECRET', 'BFMR_TRACKER_URL'] as const;
    const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
    t.after(() => {
      for (const name of names) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
    });
    process.env.BFMR_API_KEY = 'synthetic-key';
    process.env.BFMR_API_SECRET = 'synthetic-secret';
    process.env.BFMR_TRACKER_URL = 'https://api.bfmr.com/synthetic/my-tracker';
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected uninjected request'); });
    const requestedPages: number[] = [];
    let inconsistent = false;
    const request: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(url.origin, 'https://api.bfmr.com');
      assert.ok(init);
      assert.equal(init.method, 'GET');
      assert.ok(init.signal instanceof AbortSignal);
      const headers = new Headers(init.headers);
      assert.equal(headers.get('API-KEY'), 'synthetic-key');
      assert.equal(headers.get('API-SECRET'), 'synthetic-secret');
      assert.equal(url.searchParams.has('search'), false);
      assert.equal(url.searchParams.has('status'), false);
      const page = Number(url.searchParams.get('page_no'));
      requestedPages.push(page);
      return Response.json({
        my_tracker: [{ reserve_id: `R${page}`, deal_id: `D${page}` }],
        paging: { page, pages: 2, total: inconsistent && page === 2 ? 3 : 2 },
      });
    };
    assert.deepEqual(await readRecentReservedRows(request), [
      { reserve_id: 'R1', deal_id: 'D1' }, { reserve_id: 'R2', deal_id: 'D2' },
    ]);
    assert.deepEqual(requestedPages, [1, 2]);
    inconsistent = true;
    await assert.rejects(readRecentReservedRows(request), /pagination changed.*incomplete/);
    assert.deepEqual(requestedPages, [1, 2, 1, 2]);
  });
});
