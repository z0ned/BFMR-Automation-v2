/** Shared My Tracker lifecycle rules. Unknown statuses never imply absence or zero exposure. */
export const BFMR_TERMINAL = new Set(['paid', 'cancelled', 'canceled', 'returned', 'closed', 'expired', 'released']);
export const BFMR_OPEN = new Set(['reserved', 'purchased', 'ordered', 'shipped', 'delivered', 'pkg received',
  'processed', 'set aside', 'payment error', 'return', 'deadline', 'tracking submitted', 'payout pending', 'unpaid']);
export function bfmrStatus(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('My Tracker status is missing.');
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}
export function bfmrStatusClass(value: unknown): 'OPEN' | 'TERMINAL' | 'UNKNOWN' {
  const status = bfmrStatus(value);
  return BFMR_TERMINAL.has(status) ? 'TERMINAL' : BFMR_OPEN.has(status) ? 'OPEN' : 'UNKNOWN';
}
