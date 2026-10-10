import test from 'node:test';
import assert from 'node:assert/strict';
import { requireReservationAlerts, sendReservationFailureAlert, withReservationFailureAlert } from '../src/services/reservationAlerts';
import { automaticConfirmation } from '../src/services/automaticConfirmation';

// All notification transport is injected; no Telegram messages are sent.
test('Telegram failure alerts require configuration and validate delivery without exposing secrets', async () => {
  assert.throws(() => requireReservationAlerts({}), /required/);
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;
  const oldChat = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_BOT_TOKEN = 'synthetic-token';
  process.env.TELEGRAM_CHAT_ID = 'synthetic-chat';
  try {
    let sent = 0;
    const request: typeof fetch = async (url, init) => {
      assert.equal(String(url), 'https://api.telegram.org/botsynthetic-token/sendMessage');
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'error');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.chat_id, 'synthetic-chat');
      assert.match(body.text, /Startup failed/);
      assert.equal(body.text.includes('synthetic-token'), false);
      sent += 1;
      return Response.json({ ok: true, result: { message_id: 12 } });
    };
    await sendReservationFailureAlert('Startup failed', request);
    assert.equal(sent, 1);
    for (const failure of [
      async () => Response.json({ ok: false }, { status: 403 }),
      async () => Response.json({ ok: true }),
      async () => { throw new Error('https://api.telegram.org/botsynthetic-token/sendMessage'); },
    ]) {
      await assert.rejects(sendReservationFailureAlert('Startup failed', failure), error => {
        assert.equal((error as Error).message.includes('synthetic-token'), false);
        return /not delivered/.test((error as Error).message);
      });
    }
  } finally {
    if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = oldToken;
    if (oldChat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = oldChat;
  }
});

test('live failure reporting alerts once and preserves the original processing failure even if Telegram fails', async () => {
  for (const deliveryFails of [false, true]) {
    const original = new Error('reservation unresolved');
    let alerts = 0;
    await assert.rejects(withReservationFailureAlert('Email reservation stopped', async () => { throw original; }, async context => {
      alerts += 1;
      assert.equal(context, 'Email reservation stopped');
      if (deliveryFails) throw new Error('delivery failed');
    }), error => error === original);
    assert.equal(alerts, 1);
  }
  assert.equal(await withReservationFailureAlert('Confirmed', async () => 1, async () => { assert.fail('success must not alert'); }), 1);
});

test('automatic API confirmation polls delayed visibility without an operator prompt or another submission', async () => {
  let reads = 0;
  const delays: number[] = [];
  assert.deepEqual(await automaticConfirmation(async () => ++reads === 3 ? { status: 'CONFIRMED', quantity: 1 } : { status: 'NOT_VISIBLE_YET' },
    async ms => { delays.push(ms); }), { status: 'CONFIRMED', quantity: 1 });
  assert.deepEqual(delays, [5000, 5000]);
  for (const final of [{ status: 'UNKNOWN', error: 'incomplete' } as const, { status: 'EXISTING', quantity: 2 } as const]) {
    assert.deepEqual(await automaticConfirmation(async () => final, async () => assert.fail('unknown/conflict must stop polling')), final);
  }
  reads = 0;
  assert.deepEqual(await automaticConfirmation(async () => { reads += 1; return { status: 'NOT_VISIBLE_YET' }; }, async () => {}), { status: 'NOT_VISIBLE_YET' });
  assert.equal(reads, 13);
});
