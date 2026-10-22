import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { RelationalDatabase } from '../db/relationalDatabase';
import type { BusinessRepositories } from '../db/relationalRepositories';
import type { DealInput, EmailInput, JsonObject, OrderInput, ShipmentInput } from '../db/relationalTypes';
import type { AmazonOrderRecord } from './amazonOrderLedger';
import { AMAZON_ORDER_STATE_ACTION, amazonOrderCoherenceProblem, encodeAmazonOperationalState,
  supportsAmazonOrderAutomation } from './relationalOrderLedger';
import { recordVerifiedPaymentInTransaction, validateVerifiedPaymentNotice, type VerifiedPaymentNotice } from './relationalPayments';

export interface CreationProof {
  authoritativeCreationTerms: true;
  sourceSha256: string;
  verifiedAt: string;
}
export interface OrderImportProof {
  confirmedOrderIdentity: true;
  retailerEligibilityVerified: true;
  sourceSha256: string;
  verifiedAt: string;
}
export interface CutoverReservation {
  bfmrReservationId: string;
  deal: DealInput;
  sourceEmail?: EmailInput;
  quantity: number;
  payoutPerItemCents: number;
  reservationStatusId: '1' | '2' | '3';
  creationEvidence: CreationProof;
  order?: Omit<OrderInput, 'reservationId' | 'dealId'> & {
    purchasedAt: string;
    importEvidence: OrderImportProof;
    shipment?: Omit<ShipmentInput, 'orderId'> & { firstSeenAt: string; lastSeenAt: string };
  };
  reimbursement?: VerifiedPaymentNotice;
}
/** Private, operator-reviewed import contract; it is not a provider response. */
export interface FreshStartBoundary {
  mode: 'START_FROM';
  startsAt: string;
  priorCompletedActivity: 'EXCLUDED';
  noOutstandingWork: true;
}
export interface RelationalCutoverManifest {
  version: 1 | 2;
  account: string;
  approvedAt: string;
  coverage: { allReservations: true; allOrders: true; actualPayments: true } | { sinceBaseline: true };
  baseline?: FreshStartBoundary;
  legacyOrderLedgerSha256: string | null;
  excludedStandaloneOrderIds: string[];
  reservations: CutoverReservation[];
}
export interface CutoverReport {
  version: 1;
  baseline?: FreshStartBoundary;
  ready: boolean;
  reservationCount: number;
  orderCount: number;
  reimbursementCount: number;
  excludedStandaloneOrderCount: number;
  issues: string[];
}

const sha256 = (value: string) => /^[a-f0-9]{64}$/i.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const cents = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 999_999_999_999;
const nonblank = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());
const numericId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d*$/.test(value);
const sameTime = (a: string, b: string) => new Date(a).toISOString() === new Date(b).toISOString();
const decimal = (value: number) => (value / 100).toFixed(2);
function stable(value: unknown): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize) :
    item !== null && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)])) : item;
  return JSON.stringify(normalize(value));
}
function declaredOrderState(item: CutoverReservation, legacy: AmazonOrderRecord[]): AmazonOrderRecord {
  const source = item.order!;
  return legacy.find(order => order.orderId === source.orderId && order.reserveId === item.bfmrReservationId) ?? {
    orderId: source.orderId, reserveId: item.bfmrReservationId, dealId: item.deal.bfmrDealId,
    asin: source.productIdentifier, totalCents: source.totalCostCents, purchasedAt: source.purchasedAt,
    status: source.statusId === '5' ? 'DELIVERED' : source.statusId === '3' ? 'SHIPPED' : 'PENDING',
    packages: source.shipment ? [{ trackingNumber: source.shipment.trackingNumber, carrier: source.shipment.shippingCompany,
      status: source.shipment.statusId === '3' ? 'DELIVERED' : 'SHIPPED',
      firstSeenAt: source.shipment.firstSeenAt, lastSeenAt: source.shipment.lastSeenAt }] : [],
  };
}
function supportsAmazonAutomation(item: CutoverReservation): boolean {
  const order = item.order;
  return !!order && supportsAmazonOrderAutomation({ orderId: order.orderId, productIdentifier: order.productIdentifier,
    quantity: order.quantity, canceledQuantity: order.canceledQuantity ?? 0,
    statusId: order.statusId ?? '1', totalCostCents: order.totalCostCents });
}
async function amazonRetailer(tx: BusinessRepositories, retailerId: string): Promise<boolean> {
  const result = await tx.query<{ name: string }>('SELECT name FROM public.retailers WHERE id=$1::bigint', [retailerId]);
  return result.rows.length === 1 && /^amazon(?:\.com)?$/i.test(result.rows[0].name.trim());
}
function calendarDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new Error('Cutover has an invalid purchase or delivery date.');
  }
  return value;
}
function emailValid(value: EmailInput | undefined): boolean {
  return !value || (nonblank(value.gmailMessageId) && typeof value.subject === 'string' &&
    nonblank(value.emailType) && timestamp(value.receivedAt));
}

function validFreshStartBoundary(value: unknown, approvedAt: unknown): value is FreshStartBoundary {
  const boundary = value as FreshStartBoundary | undefined;
  return !!boundary && boundary.mode === 'START_FROM' && timestamp(boundary.startsAt)
    && timestamp(approvedAt) && Date.parse(boundary.startsAt) <= Date.parse(approvedAt)
    && Date.parse(approvedAt) <= Date.now() && boundary.priorCompletedActivity === 'EXCLUDED'
    && boundary.noOutstandingWork === true;
}

export function assertEmailSinceCutover(startsAt: string | null, receivedAt: string): void {
  if (startsAt !== null && (!timestamp(startsAt) || !timestamp(receivedAt)
      || Date.parse(receivedAt) < Date.parse(startsAt))) {
    throw new Error('Trigger email predates the accepted fresh-start boundary or has an invalid timestamp; no reservation may be submitted.');
  }
}

export function parseRelationalCutoverManifest(value: unknown): RelationalCutoverManifest {
  const input = value as RelationalCutoverManifest;
  if (!input || typeof input !== 'object' || ![1, 2].includes(input.version) || !nonblank(input.account) ||
      !timestamp(input.approvedAt) ||
      !(input.legacyOrderLedgerSha256 === null || (typeof input.legacyOrderLedgerSha256 === 'string' && sha256(input.legacyOrderLedgerSha256))) ||
      !Array.isArray(input.excludedStandaloneOrderIds) || !input.excludedStandaloneOrderIds.every(nonblank) ||
      new Set(input.excludedStandaloneOrderIds).size !== input.excludedStandaloneOrderIds.length ||
      !Array.isArray(input.reservations)) {
    throw new Error('Cutover manifest lacks explicit version, account, approval, complete coverage, or legacy-file hash.');
  }
  if (input.version === 1) {
    if (!input.coverage || typeof input.coverage !== 'object' || !('allReservations' in input.coverage) || input.coverage.allReservations !== true
        || input.coverage.allOrders !== true || input.coverage.actualPayments !== true
        || 'sinceBaseline' in input.coverage || input.baseline !== undefined) {
      throw new Error('Historical cutover requires complete historical coverage without a fresh-start boundary.');
    }
  } else {
    if (!validFreshStartBoundary(input.baseline, input.approvedAt) || !input.coverage || typeof input.coverage !== 'object'
        || !('sinceBaseline' in input.coverage) || input.coverage.sinceBaseline !== true
        || 'allReservations' in input.coverage || 'allOrders' in input.coverage || 'actualPayments' in input.coverage
        || input.reservations.length || input.excludedStandaloneOrderIds.length || input.legacyOrderLedgerSha256 !== null) {
      throw new Error('Fresh-start cutover requires an explicit boundary, no outstanding work and no historical import.');
    }
  }
  const reserveIds = new Set<string>();
  const orderIds = new Set<string>();
  const deals = new Map<string, string>();
  for (const item of input.reservations) {
    if (!item || !nonblank(item.bfmrReservationId) || reserveIds.has(item.bfmrReservationId) ||
        !item.deal || !nonblank(item.deal.bfmrDealId) || !nonblank(item.deal.slug) || !nonblank(item.deal.title) ||
        !cents(item.deal.reimbursementAmountCents) || (item.deal.description != null && typeof item.deal.description !== 'string') ||
        !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || item.quantity > 2147483647 ||
        !cents(item.payoutPerItemCents) || !['1', '2', '3'].includes(item.reservationStatusId) || !emailValid(item.sourceEmail) ||
        item.creationEvidence?.authoritativeCreationTerms !== true ||
        typeof item.creationEvidence.sourceSha256 !== 'string' || !sha256(item.creationEvidence.sourceSha256) ||
        !timestamp(item.creationEvidence.verifiedAt)) {
      throw new Error('Cutover reservation lacks unique identity and authoritative creation evidence.');
    }
    if (item.quantity * item.payoutPerItemCents > 999_999_999_999 || item.deal.reimbursementAmountCents > 999_999_999_999) {
      throw new Error('Cutover financial terms exceed the supported PostgreSQL money range.');
    }
    reserveIds.add(item.bfmrReservationId);
    const declaredDeal = JSON.stringify({ slug: item.deal.slug, title: item.deal.title,
      reimbursementAmountCents: item.deal.reimbursementAmountCents, description: item.deal.description ?? null });
    if (deals.has(item.deal.bfmrDealId) && deals.get(item.deal.bfmrDealId) !== declaredDeal) {
      throw new Error('Manifest contains conflicting current deal definitions.');
    }
    deals.set(item.deal.bfmrDealId, declaredDeal);
    if (item.order) {
      const order = item.order;
      if (!nonblank(order.orderId) || orderIds.has(`${order.retailerId}:${order.orderId}`) ||
          !numericId(order.retailerId) || !numericId(order.retailerAccountId) ||
          !Number.isSafeInteger(order.quantity) || order.quantity <= 0 || order.quantity > item.quantity ||
          !cents(order.totalCostCents) || !nonblank(order.productIdentifier) || !timestamp(order.purchasedAt) ||
          order.importEvidence?.confirmedOrderIdentity !== true || order.importEvidence?.retailerEligibilityVerified !== true ||
          typeof order.importEvidence.sourceSha256 !== 'string' || !sha256(order.importEvidence.sourceSha256) ||
          !timestamp(order.importEvidence.verifiedAt)) {
        throw new Error('Cutover order lacks exact original identity, cost, quantity, date or account.');
      }
      calendarDate(order.purchaseDate);
      if (order.orderTimeEstimatedDeliveryDate != null) calendarDate(order.orderTimeEstimatedDeliveryDate);
      if (order.canceledQuantity !== undefined && (!Number.isSafeInteger(order.canceledQuantity) || order.canceledQuantity < 0 || order.canceledQuantity > order.quantity)) {
        throw new Error('Cutover order canceled quantity is invalid.');
      }
      if (order.shipment && (!nonblank(order.shipment.trackingNumber) || !nonblank(order.shipment.shippingCompany) ||
          !Number.isSafeInteger(order.shipment.quantity) || order.shipment.quantity <= 0 || order.shipment.quantity > order.quantity ||
          !timestamp(order.shipment.firstSeenAt) || !timestamp(order.shipment.lastSeenAt) ||
          Date.parse(order.shipment.lastSeenAt) < Date.parse(order.shipment.firstSeenAt))) {
        throw new Error('Cutover shipment lacks a single tracking number, carrier, quantity or observation times.');
      }
      orderIds.add(`${order.retailerId}:${order.orderId}`);
    }
    if (item.reimbursement) {
      const payment = validateVerifiedPaymentNotice(item.reimbursement);
      if (payment.bfmrReservationId !== item.bfmrReservationId || payment.bfmrDealId !== item.deal.bfmrDealId) {
        throw new Error('Cutover payment does not belong to its exact reservation and deal.');
      }
    }
    if (item.reservationStatusId === '3' && (!item.reimbursement || item.reimbursement.amountCents < item.quantity * item.payoutPerItemCents)) {
      throw new Error('A reimbursed reservation requires actual payment evidence covering its creation payout.');
    }
    if (item.reimbursement && item.reimbursement.amountCents >= item.quantity * item.payoutPerItemCents && item.reservationStatusId !== '3') {
      throw new Error('A fully reimbursed reservation must be classified consistently with its actual payment.');
    }
  }
  return { ...input, account: input.account.trim().toLowerCase() };
}

export async function hashPrivateFile(file: string): Promise<string | null> {
  try { return createHash('sha256').update(await readFile(file)).digest('hex'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function readPrivateCutoverSources(manifestFile: string, legacyOrderLedgerFile: string): Promise<{
  manifest: RelationalCutoverManifest; manifestSha256: string; legacyOrders: AmazonOrderRecord[];
}> {
  const raw = await readFile(manifestFile);
  let manifest: RelationalCutoverManifest;
  try { manifest = parseRelationalCutoverManifest(JSON.parse(raw.toString('utf8'))); }
  catch (error) { throw error instanceof SyntaxError ? new Error('Cutover manifest is not valid JSON.') : error; }
  let legacyRaw: Buffer | null;
  try { legacyRaw = await readFile(legacyOrderLedgerFile); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; legacyRaw = null; }
  const actualHash = legacyRaw === null ? null : createHash('sha256').update(legacyRaw).digest('hex');
  if (actualHash !== manifest.legacyOrderLedgerSha256) throw new Error('Legacy order ledger changed or is missing; cutover was not authorized for this source.');
  let legacyOrders: AmazonOrderRecord[] = [];
  if (actualHash !== null) {
    try { legacyOrders = JSON.parse(legacyRaw!.toString('utf8')) as AmazonOrderRecord[]; }
    catch { throw new Error('Legacy order ledger is not readable JSON.'); }
    if (!Array.isArray(legacyOrders)) throw new Error('Legacy order ledger is not a record collection.');
  }
  return { manifest, manifestSha256: createHash('sha256').update(raw).digest('hex'), legacyOrders };
}

function checkLegacy(manifest: RelationalCutoverManifest, legacy: AmazonOrderRecord[], issues: string[]): void {
  const seen = new Set<string>();
  for (let index = 0; index < legacy.length; index++) {
    const order = legacy[index];
    if (!order || !nonblank(order.orderId) || seen.has(order.orderId) || !Array.isArray(order.packages)) {
      issues.push(`Legacy order at index ${index} has invalid or duplicate identity.`); continue;
    }
    seen.add(order.orderId);
    try { encodeAmazonOperationalState(order); }
    catch { issues.push(`Legacy order at index ${index} has invalid operational evidence.`); }
    if (order.reserveId === null && order.dealId === null) {
      if (!manifest.excludedStandaloneOrderIds.includes(order.orderId)) issues.push(`Standalone legacy order at index ${index} lacks an explicit retained-file exclusion.`);
      continue;
    }
    const item = manifest.reservations.find(row => row.bfmrReservationId === order.reserveId);
    const declared = item?.order;
    if (!item || !declared || item.deal.bfmrDealId !== order.dealId || declared.orderId !== order.orderId ||
        declared.productIdentifier !== order.asin || declared.totalCostCents !== order.totalCents ||
        !timestamp(order.purchasedAt) || !sameTime(declared.purchasedAt, order.purchasedAt)) {
      issues.push(`Legacy order at index ${index} is omitted or differs from its declared reservation, product, cost or purchase time.`); continue;
    }
    const statusId = order.status === 'PENDING' ? '1' : order.status === 'SHIPPED' ? '3' : order.status === 'DELIVERED' ? '5' : null;
    if (!statusId || (declared.statusId ?? '1') !== statusId) issues.push(`Legacy order at index ${index} has unreconciled order status.`);
    if (order.packages.length > 1) issues.push(`Legacy order at index ${index} has multiple packages; preserve for review before cutover.`);
    const shipment = declared.shipment;
    if (order.packages.length !== (shipment ? 1 : 0) || (shipment && order.packages.some(pkg =>
      pkg.trackingNumber !== shipment.trackingNumber || pkg.carrier !== shipment.shippingCompany ||
      (shipment.statusId ?? '1') !== (pkg.status === 'DELIVERED' ? '3' : pkg.status === 'SHIPPED' ? '1' : '') ||
      !timestamp(pkg.firstSeenAt) || !timestamp(pkg.lastSeenAt) ||
      !sameTime(pkg.firstSeenAt, shipment.firstSeenAt) || !sameTime(pkg.lastSeenAt, shipment.lastSeenAt)))) {
      issues.push(`Legacy order at index ${index} has unreconciled shipment evidence.`);
    }
  }
  for (const excluded of manifest.excludedStandaloneOrderIds) {
    if (!legacy.some(order => order.orderId === excluded && order.reserveId === null && order.dealId === null)) {
      issues.push('A standalone exclusion has no matching unlinked legacy order.');
    }
  }
}

async function inspect(tx: BusinessRepositories, manifest: RelationalCutoverManifest, legacy: AmazonOrderRecord[]): Promise<CutoverReport> {
  const issues: string[] = [];
  checkLegacy(manifest, legacy, issues);
  if (manifest.version === 2) {
    const markers = await tx.query<{ evidence: JsonObject }>(`SELECT evidence FROM public.workflow_evidence
      WHERE action_type='RELATIONAL_CUTOVER' AND phase='CONFIRMED' AND outcome='ACCEPTED'`);
    if (markers.rows.length && (markers.rows.length !== 1 || markers.rows[0].evidence.version !== 2
        || markers.rows[0].evidence.account !== manifest.account
        || stable(markers.rows[0].evidence.baseline ?? null) !== stable(manifest.baseline))) {
      issues.push('A different cutover is already accepted; a fresh start cannot replace it.');
    }
    const intake = await tx.query<{ occupied: boolean }>(`SELECT
      EXISTS(SELECT 1 FROM public.gmail_intake_state)
      OR EXISTS(SELECT 1 FROM public.gmail_intake_runs)
      OR EXISTS(SELECT 1 FROM public.gmail_intake_notifications)
      OR EXISTS(SELECT 1 FROM public.gmail_intake_work) AS occupied`);
    if (intake.rows[0]?.occupied !== false) issues.push('Existing SQL Gmail state requires reconciliation; fresh start cannot reset it.');
  }
  const reservations = await tx.reservations.list();
  const orders = await tx.orders.list();
  const payments = await tx.reimbursements.list();
  for (const current of reservations) {
    const item = manifest.reservations.find(row => row.bfmrReservationId === current.bfmr_reservation_id);
    if (!item) { issues.push('An existing database reservation is omitted from the manifest.'); continue; }
    const deal = await tx.deals.findByBfmrId(item.deal.bfmrDealId);
    if (!deal || current.deal_id !== deal.id || current.quantity !== item.quantity ||
        current.payout_per_item !== decimal(item.payoutPerItemCents) || current.reservation_status_id !== item.reservationStatusId) {
      issues.push('An existing reservation conflicts with declared identity, creation terms or status.');
    }
    const source = item.sourceEmail ? await tx.emails.findByGmailId(item.sourceEmail.gmailMessageId) : null;
    if (current.source_email_id !== (source?.id ?? null)) issues.push('An existing reservation source-email association is not reconciled.');
  }
  for (const item of manifest.reservations) {
    const deal = await tx.deals.findByBfmrId(item.deal.bfmrDealId);
    if (deal && (deal.slug !== item.deal.slug || deal.title !== item.deal.title ||
        deal.reimbursement_amount !== decimal(item.deal.reimbursementAmountCents) || deal.description !== (item.deal.description ?? null))) {
      issues.push('An existing deal differs from the declared current deal evidence.');
    }
    for (const source of [item.sourceEmail, item.reimbursement?.email].filter((row): row is EmailInput => !!row)) {
      const email = await tx.emails.findByGmailId(source.gmailMessageId);
      if (email && (email.subject !== source.subject || email.email_type !== source.emailType || !sameTime(email.received_at, source.receivedAt))) {
        issues.push('An existing email identity differs from the declared source evidence.');
      }
    }
    if (item.order) {
      const account = await tx.query<{ retailer_id: string }>('SELECT retailer_id FROM public.retailer_accounts WHERE id=$1::bigint', [item.order.retailerAccountId]);
      if (account.rows.length !== 1 || account.rows[0].retailer_id !== item.order.retailerId) {
        issues.push('Declared retailer account is missing or belongs to another retailer.');
      }
      const isAmazon = await amazonRetailer(tx, item.order.retailerId);
      if (legacy.some(row => row.orderId === item.order!.orderId && row.reserveId === item.bfmrReservationId) && !isAmazon) {
        issues.push('An Amazon legacy order was assigned to a different retailer.');
      }
      if (isAmazon && supportsAmazonAutomation(item)) {
        try {
          const state = declaredOrderState(item, legacy);
          encodeAmazonOperationalState(state);
          const coherence = amazonOrderCoherenceProblem({ statusId: item.order.statusId ?? '1',
            purchasedAt: state.purchasedAt, purchaseDate: item.order.purchaseDate,
            shipment: item.order.shipment ? { quantity: item.order.shipment.quantity,
              statusId: item.order.shipment.statusId ?? '1', shippingCompany: item.order.shipment.shippingCompany } : null });
          if (coherence) issues.push(`Declared Amazon order/shipment state is inconsistent: ${coherence}.`);
        }
        catch { issues.push('Declared Amazon operational evidence is unsupported.'); }
      }
    }
  }
  for (const current of orders) {
    const reservation = reservations.find(row => row.id === current.reservation_id);
    const item = manifest.reservations.find(row => row.bfmrReservationId === reservation?.bfmr_reservation_id);
    const declared = item?.order;
    if (!declared || current.order_id !== declared.orderId || current.retailer_account_id !== declared.retailerAccountId ||
        current.retailer_id !== declared.retailerId || current.total_cost !== decimal(declared.totalCostCents) ||
        current.product_identifier !== declared.productIdentifier || current.quantity !== declared.quantity ||
        current.purchase_date !== declared.purchaseDate || current.status_id !== (declared.statusId ?? '1') ||
        current.canceled_quantity !== (declared.canceledQuantity ?? 0) ||
        current.order_time_estimated_delivery_date !== (declared.orderTimeEstimatedDeliveryDate ?? null)) {
      issues.push('An existing database order is omitted or differs from the manifest.'); continue;
    }
    const shipment = await tx.shipments.findByOrderId(current.id);
    if (!!shipment !== !!declared.shipment || (shipment && declared.shipment && (
      shipment.tracking_number !== declared.shipment.trackingNumber || shipment.shipping_company !== declared.shipment.shippingCompany ||
      shipment.quantity !== declared.shipment.quantity || shipment.status_id !== (declared.shipment.statusId ?? '1')))) {
      issues.push('An existing database shipment is omitted or differs from the manifest.');
    }
    const snapshots = await tx.query<{ evidence: JsonObject }>(
      `SELECT evidence FROM public.workflow_evidence WHERE order_id=$1 AND action_type=$2 ORDER BY id DESC LIMIT 1`,
      [current.id, AMAZON_ORDER_STATE_ACTION],
    );
    try {
      if (!await amazonRetailer(tx, current.retailer_id) || !supportsAmazonAutomation(item!)) continue;
      const intended = encodeAmazonOperationalState(declaredOrderState(item!, legacy));
      if (snapshots.rows.length && stable(snapshots.rows[0].evidence) !== stable(intended)) {
        issues.push('Existing order workflow state differs from declared legacy evidence; it will not be overwritten.');
      }
    } catch { issues.push('Declared order operational evidence is unsupported.'); }
  }
  for (const payment of payments) {
    const reservation = reservations.find(row => row.id === payment.reservation_id);
    const item = manifest.reservations.find(row => row.bfmrReservationId === reservation?.bfmr_reservation_id);
    const declared = item?.reimbursement;
    const email = declared ? await tx.emails.findByGmailId(declared.email.gmailMessageId) : null;
    if (!declared || !email || payment.payment_email_id !== email.id || payment.amount !== decimal(declared.amountCents) ||
        !sameTime(payment.paid_at, declared.paidAt) || payment.payment_reference !== (declared.paymentReference ?? null)) {
      issues.push('An existing database reimbursement is omitted or differs from actual payment evidence.');
    }
  }
  return {
    version: 1, ...(manifest.baseline ? { baseline: manifest.baseline } : {}),
    ready: issues.length === 0, reservationCount: manifest.reservations.length,
    orderCount: manifest.reservations.filter(item => item.order).length,
    reimbursementCount: manifest.reservations.filter(item => item.reimbursement).length,
    excludedStandaloneOrderCount: manifest.excludedStandaloneOrderIds.length, issues,
  };
}

export async function reconcileRelationalCutover(db: RelationalDatabase, manifest: RelationalCutoverManifest, legacyOrders: AmazonOrderRecord[]): Promise<CutoverReport> {
  const checked = parseRelationalCutoverManifest(manifest);
  return db.withTransaction(tx => inspect(tx, checked, legacyOrders));
}

export async function assertRelationalCutoverReady(db: RelationalDatabase, options: {
  account: string; legacyOrderLedgerSha256: string | null;
}): Promise<string | null> {
  return db.withTransaction(async tx => {
    const result = await tx.query<{ evidence: JsonObject }>(
      `SELECT evidence FROM public.workflow_evidence
       WHERE action_type='RELATIONAL_CUTOVER' AND phase='CONFIRMED' AND outcome='ACCEPTED'`,
    );
    const evidence = result.rows[0]?.evidence;
    if (result.rows.length !== 1 || !evidence || (evidence.version !== 1 && evidence.version !== 2)
        || evidence.account !== options.account.trim().toLowerCase() ||
        typeof evidence.manifestSha256 !== 'string' || !sha256(evidence.manifestSha256) ||
        evidence.legacyOrderLedgerSha256 !== options.legacyOrderLedgerSha256) {
      throw new Error('Relational cutover is not accepted for this account and legacy source; reconcile before starting the writer.');
    }
    if (evidence.version === 1 && evidence.baseline === undefined) return null;
    if (evidence.version === 2 && options.legacyOrderLedgerSha256 === null
        && validFreshStartBoundary(evidence.baseline, evidence.approvedAt)) return evidence.baseline.startsAt;
    throw new Error('Accepted cutover boundary is invalid; writer must remain stopped.');
  });
}

/** Applies only database records; this module has no provider/browser action imports. */
export async function applyRelationalCutover(db: RelationalDatabase, input: {
  manifest: RelationalCutoverManifest; manifestSha256: string; legacyOrders: AmazonOrderRecord[];
}): Promise<CutoverReport> {
  const manifest = parseRelationalCutoverManifest(input.manifest);
  if (!sha256(input.manifestSha256)) throw new Error('The exact reviewed manifest hash is required.');
  try {
    return await db.withTransaction(async tx => {
      const markers = await tx.query<{ evidence: JsonObject }>(
        `SELECT evidence FROM public.workflow_evidence
         WHERE action_type='RELATIONAL_CUTOVER' AND phase='CONFIRMED' AND outcome='ACCEPTED'`,
      );
      if (markers.rows.length) {
        if (markers.rows.length !== 1 || markers.rows[0].evidence.account !== manifest.account
            || markers.rows[0].evidence.version !== manifest.version
            || stable(markers.rows[0].evidence.baseline ?? null) !== stable(manifest.baseline ?? null) ||
            markers.rows[0].evidence.manifestSha256 !== input.manifestSha256) {
          throw new Error('A different relational cutover has already been accepted.');
        }
        return { version: 1, ...(manifest.baseline ? { baseline: manifest.baseline } : {}),
          ready: true, reservationCount: manifest.reservations.length,
          orderCount: manifest.reservations.filter(item => item.order).length,
          reimbursementCount: manifest.reservations.filter(item => item.reimbursement).length,
          excludedStandaloneOrderCount: manifest.excludedStandaloneOrderIds.length, issues: [] };
      }
      const report = await inspect(tx, manifest, input.legacyOrders);
      if (!report.ready) throw new Error('Cutover reconciliation conflicts remain; no business records were imported.');
      const correlationId = randomUUID();
      for (const item of manifest.reservations) {
        const source = item.sourceEmail ? await tx.emails.upsert(item.sourceEmail) : null;
        const deal = await tx.deals.upsert(item.deal);
        if (source) {
          const association = await tx.query('SELECT 1 FROM public.email_deals WHERE email_id=$1 AND deal_id=$2', [source.id, deal.id]);
          if (!association.rows.length) await tx.emails.linkDeal(source.id, deal.id, 'CREATION');
        }
        const reservation = await tx.reservations.create({
          bfmrReservationId: item.bfmrReservationId, dealId: deal.id, sourceEmailId: source?.id,
          quantity: item.quantity, payoutPerItemCents: item.payoutPerItemCents, reservationStatusId: item.reservationStatusId,
        });
        await tx.evidence.appendObservation({
          reservationId: reservation.id, dealId: deal.id, emailId: source?.id,
          provider: 'BFMR', resourceType: 'AUTHORITATIVE_CREATION_TERMS', observedAt: item.creationEvidence.verifiedAt,
          isComplete: true, responseData: { quantity: item.quantity, payoutPerItemCents: item.payoutPerItemCents,
            sourceSha256: item.creationEvidence.sourceSha256, imported: true },
        });
        if (item.order) {
          const { shipment, purchasedAt: _purchasedAt, importEvidence, ...orderInput } = item.order;
          await tx.deals.ensureRetailer(deal.id, orderInput.retailerId);
          const order = await tx.orders.create({ ...orderInput, reservationId: reservation.id, dealId: deal.id });
          if (shipment) {
            await tx.shipments.save({ orderId: order.id, trackingNumber: shipment.trackingNumber,
              shippingCompany: shipment.shippingCompany, quantity: shipment.quantity, statusId: shipment.statusId });
          }
          if (await amazonRetailer(tx, order.retailer_id) && supportsAmazonAutomation(item)) {
            const state = declaredOrderState(item, input.legacyOrders);
            await tx.evidence.appendWorkflow({
              reservationId: reservation.id, orderId: order.id, correlationId,
              actionType: AMAZON_ORDER_STATE_ACTION, phase: 'SNAPSHOT', outcome: 'RECORDED',
              evidence: encodeAmazonOperationalState(state),
            });
          } else {
            await tx.evidence.appendWorkflow({
              reservationId: reservation.id, orderId: order.id, correlationId,
              actionType: 'RETAILER_ORDER_IMPORT', phase: 'SNAPSHOT', outcome: 'RECORDED',
              evidence: { schemaVersion: 1, purchasedAt: item.order.purchasedAt,
                sourceSha256: importEvidence.sourceSha256, quantity: order.quantity,
                statusId: order.status_id, canceledQuantity: order.canceled_quantity,
                automationManaged: false },
            });
          }
          await tx.evidence.appendObservation({
            reservationId: reservation.id, orderId: order.id, dealId: deal.id,
            provider: 'RETAILER', resourceType: 'CONFIRMED_ORDER_IMPORT', observedAt: importEvidence.verifiedAt,
            isComplete: true, responseData: { sourceSha256: importEvidence.sourceSha256,
              confirmedOrderIdentity: true, retailerEligibilityVerified: true, imported: true },
          });
        }
        if (item.reimbursement) await recordVerifiedPaymentInTransaction(tx, item.reimbursement);
      }
      await tx.evidence.appendWorkflow({
        correlationId, actionType: 'RELATIONAL_CUTOVER', phase: 'CONFIRMED', outcome: 'ACCEPTED',
        evidence: { version: manifest.version, account: manifest.account, manifestSha256: input.manifestSha256,
          ...(manifest.baseline ? { baseline: { ...manifest.baseline } } : {}),
          legacyOrderLedgerSha256: manifest.legacyOrderLedgerSha256, approvedAt: manifest.approvedAt,
          reservationCount: report.reservationCount, orderCount: report.orderCount,
          reimbursementCount: report.reimbursementCount, excludedStandaloneOrderCount: report.excludedStandaloneOrderCount },
      });
      return report;
    });
  } catch {
    // An immutable-input violation rolls back its transaction. Retain only a
    // sanitized failed-attempt marker in a separate successful transaction.
    try {
      await db.withTransaction(tx => tx.evidence.appendWorkflow({
        correlationId: randomUUID(), actionType: 'RELATIONAL_CUTOVER', phase: 'REVIEW', outcome: 'REJECTED',
        evidence: { version: 1, account: manifest.account, manifestSha256: input.manifestSha256,
          reasonCode: 'CUTOVER_RECONCILIATION_OR_IMPORT_FAILED' },
      }));
    } catch { throw new Error('Cutover import failed and review evidence could not be retained; writer must remain stopped.'); }
    throw new Error('Cutover import failed; no authoritative import was committed. Review the retained failed-attempt evidence.');
  }
}
