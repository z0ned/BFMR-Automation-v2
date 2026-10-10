import test from 'node:test';
import assert from 'node:assert/strict';
import { runBrowserSession } from '../src/services/browserSession';

test('one browser is opened before intake and reused until the session ends', async () => {
  const events: string[] = [];
  const browser = {
    async init() { events.push('open'); },
    async close() { events.push('close'); },
  };
  async function* emails() {
    events.push('listen');
    yield 'first';
    yield 'second';
  }
  await runBrowserSession(browser, emails(), async (email) => {
    assert.equal(events.includes('close'), false);
    events.push(email);
  }, async () => { assert.fail('unexpected failure'); });
  assert.deepEqual(events, ['open', 'listen', 'first', 'second', 'close']);
});

test('a failed test keeps the browser open until exit and never processes the next email', async () => {
  const events: string[] = [];
  const browser = {
    async init() { events.push('open'); },
    async close() { events.push('close'); },
  };
  async function* emails() { yield 1; yield 2; }
  await runBrowserSession(browser, emails(), async (email) => {
    events.push(`submit ${email}`);
    throw new Error('uncertain');
  }, async (error) => {
    assert.equal((error as Error).message, 'uncertain');
    assert.equal(events.includes('close'), false);
    events.push('operator exit');
  });
  assert.deepEqual(events, ['open', 'submit 1', 'operator exit', 'close']);
});
