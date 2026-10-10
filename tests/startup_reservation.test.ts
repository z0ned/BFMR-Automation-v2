import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runStartupReservation, type StartupAttempt, type StartupReservationDependencies } from '../src/services/startupReservation';
import { startupJournal } from '../src/services/startupJournal';
import { runBrowserSession } from '../src/services/browserSession';

const first = { url: 'https://www.bfmr.com/deals/first', id: 'first', title: 'First product' };
const second = { url: 'https://www.bfmr.com/deals/second', id: 'second', title: 'Second product' };
function fixture() {
  const events: string[] = [];
  const saves: StartupAttempt[] = [];
  const submitted = new Set<string>();
  let saved: StartupAttempt | null = null;
  const deps: StartupReservationDependencies = {
    listDeals: async () => { events.push('list'); return [first.url, second.url]; },
    inspectDeal: async (url) => { events.push(`inspect:${url}`); return url === first.url ? first : second; },
    check: async (deal) => { events.push(`check:${deal.id}`); return submitted.has(deal.id) ? { status: 'CONFIRMED', quantity: 1 } : { status: 'NOT_VISIBLE_YET' }; },
    submit: async (deal) => {
      assert.equal(saved?.state, 'SUBMITTING');
      assert.equal(saved?.id, deal.id);
      events.push(`submit:${deal.id}`); submitted.add(deal.id);
      return { status: 'SUBMITTED' };
    },
    journal: { load: async () => saved, save: async (value) => { saved = { ...value }; saves.push(saved); events.push(`save:${value.state}`); } },
    waitForManualAccess: async () => { events.push('manual access'); },
    wait: async (ms) => { events.push(`wait:${ms}`); },
    log: (message) => { events.push(message); },
  };
  return { deps, events, saves, submitted };
}

test('startup submits the first unreserved deal once and confirms by API without an input prompt', async () => {
  const { deps, events, saves } = fixture();
  assert.equal(await runStartupReservation(deps), 'CONFIRMED');
  assert.deepEqual(events.filter(x => x.startsWith('submit:')), ['submit:first']);
  assert.deepEqual(saves.map(x => x.state), ['SUBMITTING', 'CONFIRMED']);
});

test('live startup waits for cleanup after confirmation and preserves cleanup intent on failure', async () => {
  for (const fails of [false, true]) {
    const { deps, saves, submitted, events } = fixture();
    const reference = { reserveId: 'new-startup', dealId: 'api-deal' };
    deps.check = async deal => submitted.has(deal.id) ? { status: 'CONFIRMED', quantity: 1, reference } : { status: 'NOT_VISIBLE_YET' };
    deps.afterConfirmed = async target => {
      assert.deepEqual(target, reference);
      assert.equal(saves.at(-1)?.state, 'CLEANUP_PENDING');
      events.push('cleanup');
      if (fails) throw new Error('cleanup uncertain');
    };
    if (fails) await assert.rejects(runStartupReservation(deps), /cleanup uncertain/);
    else assert.equal(await runStartupReservation(deps), 'CONFIRMED');
    assert.equal(saves.at(-1)?.state, fails ? 'CLEANUP_PENDING' : 'CLEANED');
    assert.equal(events.filter(x => x === 'cleanup').length, 1);
    assert.equal(events.filter(x => x.startsWith('submit:')).length, 1);
  }
});

test('unfinished startup cleanup is recovered before listing or another submission', async () => {
  const { deps, events } = fixture();
  deps.journal.load = async () => ({ ...first, ordinal: 1, state: 'CLEANUP_PENDING', reference: { reserveId: 'old', dealId: 'api-id' } });
  deps.afterConfirmed = async () => { throw new Error('cleanup still unresolved'); };
  await assert.rejects(runStartupReservation(deps), /cleanup still unresolved/);
  assert.equal(events.includes('list'), false);
  assert.equal(events.some(x => x.startsWith('submit:')), false);
});

test('duplicate and unavailable candidates move forward in the displayed list', async () => {
  for (const skipped of ['duplicate', 'unavailable']) {
    const { deps, events } = fixture();
    const inspect = deps.inspectDeal; const check = deps.check;
    if (skipped === 'unavailable') deps.inspectDeal = async (url) => url === first.url ? null : inspect(url);
    else deps.check = async (deal) => deal.id === first.id ? { status: 'EXISTING', quantity: 4 } : check(deal);
    await runStartupReservation(deps);
    assert.deepEqual(events.filter(x => x.startsWith('submit:')), ['submit:second']);
  }
});

test('manual CAPTCHA completion is followed by automatic API confirmation without a second click', async () => {
  const { deps, events } = fixture();
  let completed = false;
  deps.submit = async () => { events.push('submit'); return { status: 'SUBMITTED' }; };
  deps.waitForManualAccess = async () => { events.push('human completed CAPTCHA'); completed = true; };
  deps.check = async () => completed ? { status: 'CONFIRMED', quantity: 1 } : { status: 'NOT_VISIBLE_YET' };
  assert.equal(await runStartupReservation(deps), 'CONFIRMED');
  assert.equal(events.filter(x => x === 'submit').length, 1);
  assert.equal(events.includes('human completed CAPTCHA'), true);
});

test('unknown preflight or a failed durable write prevents any click', async () => {
  for (const failure of ['tracker', 'journal']) {
    const { deps, events } = fixture();
    if (failure === 'tracker') deps.check = async () => ({ status: 'UNKNOWN', error: 'incomplete read' });
    else deps.journal.save = async () => { throw new Error('disk failure'); };
    await assert.rejects(runStartupReservation(deps));
    assert.equal(events.some(x => x.startsWith('submit:')), false);
  }
});

test('missing tracker visibility, unknown reads and quantity conflicts never authorize another submit', async () => {
  for (const failure of ['absent', 'unknown', 'conflict']) {
    const { deps, events, saves } = fixture();
    let afterClick = false;
    deps.submit = async () => { events.push('submit'); afterClick = true; return { status: 'UNCERTAIN' }; };
    deps.check = async () => !afterClick || failure === 'absent' ? { status: 'NOT_VISIBLE_YET' } :
      failure === 'unknown' ? { status: 'UNKNOWN', error: 'network' } : { status: 'EXISTING', quantity: 2 };
    await assert.rejects(runStartupReservation(deps));
    assert.equal(events.filter(x => x === 'submit').length, 1);
    assert.equal(saves.at(-1)?.state, 'REVIEW');
  }
});

test('proved failures exhaust two ordinals then advance to the next deal until success', async () => {
  const { deps, events, saves } = fixture();
  const submit = deps.submit;
  deps.submit = async (deal) => {
    if (deal.id === second.id) return submit(deal);
    events.push('submit'); return { status: 'FAILED_500', definitiveNonCreation: true };
  };
  assert.equal(await runStartupReservation(deps), 'CONFIRMED');
  assert.equal(events.filter(x => x === 'submit').length, 2);
  assert.deepEqual(saves.map(x => [x.ordinal, x.state]), [[1, 'SUBMITTING'], [1, 'RETRY_PENDING'], [2, 'SUBMITTING'], [2, 'EXHAUSTED'], [1, 'SUBMITTING'], [1, 'CONFIRMED']]);
  assert.equal(events.filter(x => x.startsWith('inspect:')).length, 3);
});

test('proved startup failures notify before retry; failed alert delivery stops further submissions', async () => {
  for (const deliveryFails of [false, true]) {
    const { deps, events } = fixture();
    let submits = 0;
    deps.submit = async () => {
      submits += 1;
      return submits === 1 ? { status: 'FAILED_500', definitiveNonCreation: true } : { status: 'SUBMITTED' };
    };
    deps.check = async () => submits === 2 ? { status: 'CONFIRMED', quantity: 1 } : { status: 'NOT_VISIBLE_YET' };
    deps.onProvedFailure = async () => { events.push('alert'); if (deliveryFails) throw new Error('Telegram blocked'); };
    if (deliveryFails) await assert.rejects(runStartupReservation(deps), /Telegram blocked/);
    else assert.equal(await runStartupReservation(deps), 'CONFIRMED');
    assert.equal(submits, deliveryFails ? 1 : 2);
    assert.equal(events.filter(event => event === 'alert').length, 1);
  }
});

test('a 500 without proof of non-creation stays uncertain', async () => {
  const { deps, events } = fixture();
  deps.submit = async () => { events.push('submit'); return { status: 'FAILED_500' }; };
  await assert.rejects(runStartupReservation(deps), /uncertain/);
  assert.equal(events.filter(x => x === 'submit').length, 1);
});

test('restart cannot erase an unresolved possible startup submission', async () => {
  const { deps, events } = fixture();
  deps.journal.load = async () => ({ ...first, ordinal: 1, state: 'SUBMITTING' });
  await assert.rejects(runStartupReservation(deps), /previous startup reservation is unresolved/);
  assert.equal(events.includes('list'), false);
  assert.equal(events.some(x => x.startsWith('submit:')), false);
});

test('a persisted proved-failure retry uses only ordinal two', async () => {
  const { deps, saves } = fixture();
  deps.journal.load = async () => ({ ...first, ordinal: 1, state: 'RETRY_PENDING' });
  await runStartupReservation(deps);
  assert.deepEqual(saves.map(x => x.ordinal), [2, 2]);
});

test('no displayed candidate proceeds without submitting', async () => {
  const { deps, events } = fixture(); deps.listDeals = async () => [];
  assert.equal(await runStartupReservation(deps), 'NO_CANDIDATE');
  assert.equal(events.some(x => x.startsWith('submit:')), false);
});

test('the session completes startup before email processing and retains the browser on startup failure', async () => {
  for (const fail of [false, true]) {
    const events: string[] = [];
    await runBrowserSession({ init: async () => { events.push('open'); }, close: async () => { events.push('close'); } },
      (async function* () { events.push('intake'); yield 'email'; })(),
      async () => { events.push('process'); }, async () => { events.push('retained'); },
      async () => { events.push('baseline'); events.push('startup'); if (fail) throw new Error('uncertain'); });
    assert.deepEqual(events, fail ? ['open', 'baseline', 'startup', 'retained', 'close'] : ['open', 'baseline', 'startup', 'intake', 'process', 'close']);
  }
});

test('the local journal persists recovery evidence and rejects corrupt state', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bfmr-startup-'));
  try {
    const file = path.join(directory, 'attempt.json'); const store = startupJournal(file);
    assert.equal(await store.load(), null);
    await store.save({ ...first, ordinal: 1, state: 'SUBMITTING' });
    assert.equal((await startupJournal(file).load())?.state, 'SUBMITTING');
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal(JSON.parse((await fs.readFile(`${file}.events.jsonl`, 'utf8')).trim()).state, 'SUBMITTING');
    await fs.writeFile(file, '{broken'); await assert.rejects(store.load());
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
