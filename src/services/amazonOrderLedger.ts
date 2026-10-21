import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const AMAZON_ORDER_ID = /^\d{3}-\d{7}-\d{7}$/;
export const AMAZON_ASIN = /^[A-Z0-9]{10}$/;

export interface TrackedPackage {
  trackingNumber: string;
  carrier: string | null;
  status: 'SHIPPED' | 'DELIVERED';
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface AmazonOrderRecord {
  orderId: string;
  reserveId: string | null;
  dealId: string | null;
  asin: string;
  totalCents: number;
  purchasedAt: string;
  status: 'PENDING' | 'SHIPPED' | 'DELIVERED';
  packages: TrackedPackage[];
  lastCheckedAtlantaDay?: string;
  lastAttemptAtlantaDay?: string;
  lastError?: string;
  bfmrPurchaseIntentAt?: string;
  bfmrPurchaseId?: string;
  bfmrShipmentIntent?: { trackingNumber: string; at: string };
  bfmrShipmentId?: string;
  bfmrTrackingSubmittedAt?: string;
  bfmrOfficial?: {
    status: string;
    quantity: number;
    purchaseId: string | null;
    shipmentId: string | null;
    orderNo: string | null;
    trackingNumber: string | null;
    observedAt: string;
  };
}

/** Business persistence boundary; file and relational implementations share it. */
export type LedgerUpdateSource = 'AMAZON' | 'BFMR' | 'OPERATIONAL';
export interface AmazonOrderLedger {
  load(): Promise<AmazonOrderRecord[]>;
  add(record: AmazonOrderRecord): Promise<void>;
  update(record: AmazonOrderRecord, source?: LedgerUpdateSource): Promise<void>;
  recordReview?(orderId: string, reason: string, evidence?: Record<string, unknown>): Promise<void>;
}

export function validateAmazonOrderRecord(value: unknown): AmazonOrderRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Amazon order ledger record.');
  const item = value as Record<string, unknown>;
  if (typeof item.orderId !== 'string' || !AMAZON_ORDER_ID.test(item.orderId) ||
    (item.reserveId !== null && (typeof item.reserveId !== 'string' || !item.reserveId)) ||
    (item.dealId !== null && (typeof item.dealId !== 'string' || !item.dealId)) ||
    ((item.reserveId === null) !== (item.dealId === null)) ||
    typeof item.asin !== 'string' || !AMAZON_ASIN.test(item.asin) ||
    !Number.isSafeInteger(item.totalCents) || Number(item.totalCents) <= 0 ||
    typeof item.purchasedAt !== 'string' || !Number.isFinite(Date.parse(item.purchasedAt)) ||
    !['PENDING', 'SHIPPED', 'DELIVERED'].includes(String(item.status)) ||
    !Array.isArray(item.packages) || !item.packages.every((pkg) => pkg &&
      typeof pkg.trackingNumber === 'string' && /^[A-Z0-9-]{8,40}$/i.test(pkg.trackingNumber) &&
      (pkg.carrier === null || typeof pkg.carrier === 'string') &&
      ['SHIPPED', 'DELIVERED'].includes(pkg.status) &&
      typeof pkg.firstSeenAt === 'string' && typeof pkg.lastSeenAt === 'string') ||
    (item.lastCheckedAtlantaDay !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(item.lastCheckedAtlantaDay))) ||
    (item.lastAttemptAtlantaDay !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(item.lastAttemptAtlantaDay))) ||
    (item.lastError !== undefined && typeof item.lastError !== 'string') ||
    (item.bfmrPurchaseIntentAt !== undefined && typeof item.bfmrPurchaseIntentAt !== 'string') ||
    (item.bfmrPurchaseId !== undefined && typeof item.bfmrPurchaseId !== 'string') ||
    (item.bfmrShipmentId !== undefined && typeof item.bfmrShipmentId !== 'string') ||
    (item.bfmrTrackingSubmittedAt !== undefined && typeof item.bfmrTrackingSubmittedAt !== 'string') ||
    (item.bfmrOfficial !== undefined && (!item.bfmrOfficial || typeof item.bfmrOfficial !== 'object' ||
      typeof (item.bfmrOfficial as Record<string, unknown>).status !== 'string' ||
      !Number.isSafeInteger((item.bfmrOfficial as Record<string, unknown>).quantity) ||
      typeof (item.bfmrOfficial as Record<string, unknown>).observedAt !== 'string')) ||
    (item.bfmrShipmentIntent !== undefined && (!item.bfmrShipmentIntent ||
      typeof item.bfmrShipmentIntent !== 'object' ||
      typeof (item.bfmrShipmentIntent as Record<string, unknown>).at !== 'string' ||
      typeof (item.bfmrShipmentIntent as Record<string, unknown>).trackingNumber !== 'string'))) {
    throw new Error('Invalid Amazon order ledger record.');
  }
  return item as unknown as AmazonOrderRecord;
}

/** One account worker writes this file. Use a private atomic/fsynced replacement. */
export function amazonOrderLedger(file: string) {
  async function withLock<T>(action: () => Promise<T>): Promise<T> {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const lockPath = `${file}.lock`;
    let lock: fs.FileHandle | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { lock = await fs.open(lockPath, 'wx', 0o600); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!lock) throw new Error('Amazon order ledger is locked; no record was changed. Review the writer before retrying.');
    try { return await action(); }
    finally { await lock.close(); await fs.unlink(lockPath); }
  }
  return {
    async load(): Promise<AmazonOrderRecord[]> {
      let raw: string;
      try { raw = await fs.readFile(file, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('Invalid Amazon order ledger; review before continuing.');
      const records = parsed.map(validateAmazonOrderRecord);
      if (new Set(records.map((record) => record.orderId)).size !== records.length) {
        throw new Error('Duplicate Amazon order IDs in ledger; review before continuing.');
      }
      return records;
    },
    async save(records: AmazonOrderRecord[]): Promise<void> {
      records.forEach(validateAmazonOrderRecord);
      if (new Set(records.map((record) => record.orderId)).size !== records.length) {
        throw new Error('Duplicate Amazon order IDs in ledger; no changes saved.');
      }
      const directory = path.dirname(file);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(records)); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, file);
      const parent = await fs.open(directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    },
    async add(record: AmazonOrderRecord): Promise<void> {
      validateAmazonOrderRecord(record);
      await withLock(async () => {
        const records = await this.load();
        const existing = records.find((item) => item.orderId === record.orderId);
        if (existing) {
          if (existing.reserveId !== record.reserveId || existing.asin !== record.asin || existing.totalCents !== record.totalCents) {
            throw new Error(`Amazon order ${record.orderId} conflicts with an existing ledger entry.`);
          }
          return;
        }
        if (record.reserveId && records.some((item) => item.reserveId === record.reserveId)) {
          throw new Error(`BFMR reservation ${record.reserveId} already has a different Amazon order ID in the ledger.`);
        }
        await this.save([...records, record]);
      });
    },
    async update(record: AmazonOrderRecord, _source?: LedgerUpdateSource): Promise<void> {
      validateAmazonOrderRecord(record);
      await withLock(async () => {
        const records = await this.load();
        const index = records.findIndex((item) => item.orderId === record.orderId);
        if (index < 0 || records[index].reserveId !== record.reserveId || records[index].asin !== record.asin) {
          throw new Error(`Amazon order ${record.orderId} is missing or its identity changed; no tracking saved.`);
        }
        records[index] = record;
        await this.save(records);
      });
    },
  };
}
