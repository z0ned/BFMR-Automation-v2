import { bfmrStatus, bfmrStatusClass } from './bfmrStatus';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readRecentReservedRows, type TrackerReservationRow } from './bfmrTrackerApi';
import type { AmazonOrderLedger, AmazonOrderRecord } from './amazonOrderLedger';
import { atlantaDayAndHour } from './nightlyAmazonTracking';
import type { PrivateStateStore } from './privateJsonStore';

export interface BfmrStatusRow {
  reserveId: string;
  dealId: string;
  status: string;
  quantity: number;
  purchaseId: string | null;
  shipmentId: string | null;
  orderNo: string | null;
  trackingNumber: string | null;
}

export interface BfmrStatusSnapshot {
  atlantaDay: string;
  observedAt: string;
  openRows: BfmrStatusRow[];
  pendingAlerts: string[];
  nextAlert: number;
  reservations?: Array<{ reserveId: string; history: Array<BfmrStatusRow & { observedAt: string }>; missingSince: string | null }>;
  discrepancies?: Array<{ detail: string; firstSeenAt: string; lastSeenAt: string; resolvedAt: string | null }>;

}

function identifier(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function summarizeBfmrRows(rows: TrackerReservationRow[]): { all: BfmrStatusRow[]; open: BfmrStatusRow[]; issues: string[] } {
  const all: BfmrStatusRow[] = [];
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    const reserveId = identifier(raw.reserve_id);
    const dealId = identifier(raw.deal_id);
    const status = bfmrStatus(raw.status ?? raw.item_status ?? raw.reservation_status);
    const quantity = Number(raw.qty ?? raw.quantity);
    if (!reserveId || !dealId || !Number.isSafeInteger(quantity) || quantity < 0) {
      throw new Error('My Tracker row has incomplete reservation identity or quantity.');
    }
    if (seen.has(reserveId)) throw new Error(`My Tracker returned duplicate reservation ${reserveId}; daily comparison is inconclusive.`);
    seen.add(reserveId);
    if (bfmrStatusClass(status) === 'UNKNOWN') issues.push(`Reservation ${reserveId}: unrecognized BFMR status ${status}.`);
    all.push({ reserveId, dealId, status, quantity,
      purchaseId: identifier(raw.purchase_id), shipmentId: identifier(raw.shipment_id),
      orderNo: nullableText(raw.order_no), trackingNumber: nullableText(raw.tracking_number) });
  }
  return { all, open: all.filter((row) => bfmrStatusClass(row.status) !== 'TERMINAL'), issues };
}

export function bfmrDiscrepancies(previous: BfmrStatusSnapshot | null, official: ReturnType<typeof summarizeBfmrRows>,
  orders: AmazonOrderRecord[]): string[] {
  const issues = [...official.issues];
  const byId = new Map(official.all.map((row) => [row.reserveId, row]));
  const localById = new Map(orders.filter((order) => order.reserveId).map((order) => [order.reserveId as string, order]));
  for (const prior of previous?.reservations?.filter(item => bfmrStatusClass(item.history.at(-1)!.status) !== 'TERMINAL').map(item => item.history.at(-1)!) ?? previous?.openRows ?? []) {
    if (!byId.has(prior.reserveId)) issues.push(`Reservation ${prior.reserveId}: previously open BFMR row is missing from the complete My Tracker read.`);
  }
  for (const row of official.open) {
    if (!localById.has(row.reserveId)) issues.push(`Reservation ${row.reserveId}: open in BFMR, absent from the local Amazon order ledger.`);
  }
  for (const order of orders) {
    if (!order.reserveId) continue;
    const row = byId.get(order.reserveId);
    if (!row) { issues.push(`Amazon order ${order.orderId}: BFMR reservation ${order.reserveId} is missing.`); continue; }
    if (row.dealId !== order.dealId || row.quantity !== 1) issues.push(`Reservation ${order.reserveId}: BFMR deal or quantity differs from the local order.`);
    if (bfmrStatusClass(row.status) === 'TERMINAL' && row.status !== 'paid' && row.status !== 'closed') {
      issues.push(`Reservation ${order.reserveId}: BFMR status is ${row.status} despite a recorded Amazon purchase.`);
    }
    if (row.status === 'reserved' || (order.packages.length > 0 && row.status === 'purchased')) {
      issues.push(`Reservation ${order.reserveId}: BFMR status ${row.status} is behind the recorded Amazon purchase/shipment.`);
    }
    if (order.packages.length === 0 && (row.status === 'shipped' || row.status === 'pkg received')) {
      issues.push(`Reservation ${order.reserveId}: BFMR shows shipment before local Amazon tracking was found.`);
    }
    if (row.orderNo !== order.orderId) issues.push(`Reservation ${order.reserveId}: BFMR Order # is missing or differs from Amazon order ${order.orderId}.`);
    if (order.bfmrPurchaseId && row.purchaseId !== order.bfmrPurchaseId) issues.push(`Reservation ${order.reserveId}: BFMR purchase ID differs from the local record.`);
    if (order.bfmrShipmentId && row.shipmentId !== order.bfmrShipmentId) issues.push(`Reservation ${order.reserveId}: BFMR shipment ID differs from the local record.`);
    if (order.packages.length === 1 && row.trackingNumber?.toUpperCase() !== order.packages[0].trackingNumber.toUpperCase()) {
      issues.push(`Reservation ${order.reserveId}: BFMR tracking is missing or differs from Amazon.`);
    }
    if (order.packages.length > 1) issues.push(`Reservation ${order.reserveId}: multiple Amazon package numbers require manual BFMR matching.`);
    if (row.trackingNumber && !order.packages.some((pkg) => pkg.trackingNumber.toUpperCase() === row.trackingNumber?.toUpperCase())) {
      issues.push(`Reservation ${order.reserveId}: BFMR has tracking absent from the local Amazon order.`);
    }
  }
  return [...new Set(issues)];
}

function alertMessages(day: string, issues: string[]): string[] {
  if (!issues.length) return [];
  const messages: string[] = [];
  let lines: string[] = [];
  let length = 0;
  for (const issue of issues) {
    const line = `• ${issue.slice(0, 350)}`;
    if (lines.length >= 8 || length + line.length > 2800) {
      messages.push(`BFMR daily status discrepancies (${day} Atlanta):\n${lines.join('\n')}\nReview My Tracker and the local BFMR status snapshot.`);
      lines = []; length = 0;
    }
    lines.push(line); length += line.length;
  }
  if (lines.length) messages.push(`BFMR daily status discrepancies (${day} Atlanta):\n${lines.join('\n')}\nReview My Tracker and the local BFMR status snapshot.`);
  return messages;
}

export type BfmrStatusStore = PrivateStateStore<BfmrStatusSnapshot>;
export function bfmrStatusStore(file: string): BfmrStatusStore {
  return {
    async load(): Promise<BfmrStatusSnapshot | null> {
      let raw: string;
      try { raw = await fs.readFile(file, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid BFMR status snapshot.');
      const snapshot = value as BfmrStatusSnapshot;
      if (typeof snapshot.atlantaDay !== 'string' || typeof snapshot.observedAt !== 'string' ||
        !Array.isArray(snapshot.openRows) || !snapshot.openRows.every((row) => row && typeof row.reserveId === 'string' &&
          typeof row.dealId === 'string' && typeof row.status === 'string' && Number.isSafeInteger(row.quantity)) ||
        !Array.isArray(snapshot.pendingAlerts) || !snapshot.pendingAlerts.every((item) => typeof item === 'string') ||
        !Number.isSafeInteger(snapshot.nextAlert) || snapshot.nextAlert < 0 || snapshot.nextAlert > snapshot.pendingAlerts.length) {
        throw new Error('Invalid BFMR status snapshot.');
      }
      return snapshot;
    },
    async save(snapshot: BfmrStatusSnapshot): Promise<void> {
      const directory = path.dirname(file);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(snapshot)); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, file);
      const parent = await fs.open(directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    },
  };
}

export async function runDueBfmrStatusCheck(options: {
  store: BfmrStatusStore;
  ledger: AmazonOrderLedger;
  hasIncomingMail: () => Promise<boolean>;
  notify: (message: string) => Promise<void>;
  readRows?: () => Promise<TrackerReservationRow[]>;
  reconcile?: (rows: TrackerReservationRow[]) => Promise<{ promoted: boolean; issues: string[] }>;
  onDiscrepancies?: () => Promise<void>;
  now?: () => Date;
}): Promise<void> {
  const { day, hour } = atlantaDayAndHour(options.now?.() ?? new Date());
  if (hour < 3) return;
  if (await options.hasIncomingMail()) return;
  let previous = await options.store.load();
  let deliveryError: unknown;
  if (previous && previous.nextAlert < previous.pendingAlerts.length) {
    for (let index = previous.nextAlert; index < previous.pendingAlerts.length; index++) {
      try { await options.notify(previous.pendingAlerts[index]); }
      catch (error) { deliveryError = error; break; }
      previous.nextAlert = index + 1;
      await options.store.save(previous);
    }
  }
  if (previous?.atlantaDay === day) {
    if (deliveryError) throw deliveryError;
    return;
  }
  const rows = await (options.readRows ?? readRecentReservedRows)();
  const reconciliation = await options.reconcile?.(rows);
  if (reconciliation && !reconciliation.promoted) {
    throw new Error('BFMR reconciliation retained conflicting/incomplete evidence; authoritative status was not changed.');
  }
  const official = summarizeBfmrRows(rows);
  const orders = await options.ledger.load();
  const issues = bfmrDiscrepancies(previous, official, orders);
  const observedAt = (options.now?.() ?? new Date()).toISOString();
  for (const order of orders) {
    if (!order.reserveId) continue;
    const row = official.all.find((item) => item.reserveId === order.reserveId);
    if (!row) continue;
    await options.ledger.update({ ...order, bfmrOfficial: {
      status: row.status, quantity: row.quantity, purchaseId: row.purchaseId, shipmentId: row.shipmentId,
      orderNo: row.orderNo, trackingNumber: row.trackingNumber, observedAt,
    } }, 'BFMR');
  }
  const reservations = structuredClone(previous?.reservations ?? (previous?.openRows ?? []).map(row => ({
    reserveId: row.reserveId, history: [{ ...row, observedAt: previous!.observedAt }], missingSince: null as string | null,
  })));
  for (const entry of reservations) if (!official.all.some(row => row.reserveId === entry.reserveId)) {
    entry.missingSince ??= observedAt;
  }
  for (const row of official.all) {
    let entry = reservations.find(item => item.reserveId === row.reserveId);
    if (!entry) { entry = { reserveId: row.reserveId, history: [], missingSince: null }; reservations.push(entry); }
    entry.history.push({ ...row, observedAt });
    entry.missingSince = null;
  }
  const discrepancies = structuredClone(previous?.discrepancies ?? []);
  for (const entry of discrepancies) {
    if (issues.includes(entry.detail)) { entry.lastSeenAt = observedAt; entry.resolvedAt = null; }
    else entry.resolvedAt ??= observedAt;
  }
  for (const detail of issues) if (!discrepancies.some(entry => entry.detail === detail)) {
    discrepancies.push({ detail, firstSeenAt: observedAt, lastSeenAt: observedAt, resolvedAt: null });
  }
  const unsent = previous?.pendingAlerts.slice(previous.nextAlert) ?? [];
  const snapshot: BfmrStatusSnapshot = { atlantaDay: day, observedAt, openRows: official.open, reservations, discrepancies,
    pendingAlerts: [...unsent, ...alertMessages(day, issues)], nextAlert: 0 };
  await options.store.save(snapshot);
  if (issues.length) await options.onDiscrepancies?.();
  if (deliveryError) throw deliveryError;
  for (let index = 0; index < snapshot.pendingAlerts.length; index++) {
    await options.notify(snapshot.pendingAlerts[index]);
    snapshot.nextAlert = index + 1;
    await options.store.save(snapshot);
  }
  console.log(`[BFMR daily status] ${official.open.length} open reservations/orders checked; ${issues.length} discrepancies.`);
}
