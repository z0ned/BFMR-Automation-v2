import { privateJsonStore } from './privateJsonStore';
import type { MailHeader } from './emailProvenance';

export interface QueuedEmail {
  id: string; sender: string; subject: string; body: string; receivedAt: string; inboxAtFetch?: boolean; headers?: MailHeader[];
}
export interface GmailQueueState {
  mailbox: string; cursor: string; gap: boolean;
  work: Array<{ id: string; state: 'PENDING' | 'PROCESSING' | 'DONE'; email?: QueuedEmail }>;
}
export function gmailIntakeQueue(file: string) {
  const store = privateJsonStore<GmailQueueState>(file, (value) => {
    const state = value as GmailQueueState;
    if (!state || typeof state.mailbox !== 'string' || !/^\d+$/.test(state.cursor) || typeof state.gap !== 'boolean' ||
      !Array.isArray(state.work) || !state.work.every(item => item && typeof item.id === 'string' &&
        ['PENDING', 'PROCESSING', 'DONE'].includes(item.state) && (item.state === 'DONE' ||
          item.email?.id === item.id && typeof item.email.body === 'string' && typeof item.email.sender === 'string')) ||
      new Set(state.work.map(item => item.id)).size !== state.work.length) throw new Error('Invalid durable Gmail queue; do not reset its cursor.');
    return state;
  });
  return {
    ...store,
    async initialize(mailbox: string, initialCursor: string, allowInitialize = false): Promise<GmailQueueState> {
      const existing = await store.load();
      if (existing) {
        if (existing.mailbox !== mailbox) throw new Error('Saved Gmail queue belongs to a different mailbox.');
        if (existing.gap) throw new Error('GMAIL_HISTORY_GAP: saved cursor requires operator resolution.');
        if (existing.work.some(item => item.state === 'PROCESSING')) throw new Error('A Gmail item was interrupted during processing; reconcile its BFMR/Amazon effects before resuming.');
        return existing;
      }
      if (!allowInitialize) throw new Error('Gmail queue is missing. First setup requires explicit BFMR_INITIALIZE_GMAIL_QUEUE=YES; restore saved state for an existing installation.');
      const state: GmailQueueState = { mailbox, cursor: initialCursor, gap: false, work: [] };
      await store.save(state);
      return state;
    },
    async ingest(expectedCursor: string, nextCursor: string, emails: QueuedEmail[]): Promise<void> {
      const state = await store.load();
      if (!state || state.gap || state.cursor !== expectedCursor || !/^\d+$/.test(nextCursor) || BigInt(nextCursor) < BigInt(expectedCursor)) {
        throw new Error('Gmail cursor changed or regressed; batch was not committed.');
      }
      for (const email of emails) if (!state.work.some(item => item.id === email.id)) {
        state.work.push({ id: email.id, state: 'PENDING', email });
      }
      state.cursor = nextCursor;
      // The queued payloads and consumed cursor commit together in one replacement.
      await store.save(state);
    },
    async mark(id: string, next: 'PROCESSING' | 'DONE'): Promise<void> {
      const state = await store.load();
      const item = state?.work.find(item => item.id === id);
      if (!state || !item || item.state === 'DONE' || (next === 'PROCESSING' && item.state !== 'PENDING')) throw new Error('Gmail work transition is invalid.');
      item.state = next;
      if (next === 'DONE') delete item.email;
      await store.save(state);
    },
  };
}
