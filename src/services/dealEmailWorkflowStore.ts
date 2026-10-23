import { assertIntakePrivileges } from '../db/intakePrivileges';
import { createHash, randomUUID } from 'node:crypto';
import type { RelationalDatabase } from '../db/relationalDatabase';
import type { BusinessRepositories } from '../db/relationalRepositories';
import type { JsonObject } from '../db/relationalTypes';
import type { ReservationReference } from './amazonEvaluation';
import type { AmazonOrderRecord } from './amazonOrderLedger';
import { validateAmazonOrderRecord } from './amazonOrderLedger';
import { isTrustedBfmrDealUrl } from './bfmrUrl';

export const EMAIL_WORKFLOW_ACTION = 'DEAL_EMAIL_WORKFLOW';
export const DEAL_STEPS = ['PENDING', 'RESERVING', 'RESERVED', 'EVALUATING', 'ELIGIBLE', 'CHECKOUT_PREPARING',
  'CHECKOUT_INTENT', 'ORDER_CONFIRMED', 'ORDER_RECORDED', 'PURCHASE_UPDATE_INTENT', 'COMPLETE', 'CANCEL_INTENT', 'CANCELLED', 'SKIPPED'] as const;
export type DealStep = typeof DEAL_STEPS[number];
export interface DealProgress {
  dealUrl: string;
  step: DealStep;
  dealId?: string;
  targetAsin?: string;
  reference?: ReservationReference;
  checkout?: { asin: string; totalCents: number; payoutCents: number; productUrl: string };
  order?: AmazonOrderRecord;
  cancelReason?: 'SUPPLIER_ABSENT' | 'CHECKOUT_RULE';
  cartNeedsReview?: boolean;
}
export interface DealEmailState {
  schemaVersion: 1;
  workflowId: string;
  account: string;
  source: 'GMAIL' | 'LOCAL_PDF_TEST';
  messageId: string;
  messageType: 'SINGLE_DEAL' | 'MULTI_DEAL';
  sourceSha256: string;
  retailerAccountId: string;
  startedAt: string;
  status: 'RUNNING' | 'PAUSED' | 'READY' | 'COMPLETE';
  deals: DealProgress[];
}
export interface LegacyStatusOverride {
  predecessorRevision: string;
  invalidSnapshotSha256: string;
}
export interface WorkflowCheckpoint {
  revision: string;
  state: DealEmailState;
  legacyStatusOverride?: LegacyStatusOverride;
}
export class LegacyWorkflowSnapshotError extends Error {
  constructor() {
    super('Invalid workflow completion cannot be substantiated by its immediate preceding snapshot. Preserve history; no local repair or provider retry was performed.');
  }
}
export interface WorkflowEmail {
  id: string; sender: string; subject: string; body: string; receivedAt: string;
  headers?: Array<{ name?: string | null; value?: string | null }>; inboxAtFetch?: boolean;
  source?: 'GMAIL' | 'LOCAL_PDF_TEST';
}
export const terminalDeal = (deal: DealProgress) => ['COMPLETE', 'CANCELLED', 'SKIPPED'].includes(deal.step) && !deal.cartNeedsReview;
export function canonicalWorkflowJson(value: unknown): string {
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)])) : v;
  return JSON.stringify(sorted(value));
}
export function emailSourceSha256(email: WorkflowEmail): string {
  return createHash('sha256').update(canonicalWorkflowJson({ id: email.id, sender: email.sender, subject: email.subject,
    body: email.body, receivedAt: email.receivedAt, headers: email.headers ?? [], inboxAtFetch: email.inboxAtFetch ?? false,
    source: email.source ?? 'GMAIL' })).digest('hex');
}
export function validateDealEmailState(value: unknown): DealEmailState {
  const s = value as DealEmailState;
  if (!s || s.schemaVersion !== 1 || !/^[0-9a-f-]{36}$/i.test(s.workflowId) || !s.account ||
      !['GMAIL', 'LOCAL_PDF_TEST'].includes(s.source) || !s.messageId ||
      !['SINGLE_DEAL', 'MULTI_DEAL'].includes(s.messageType) || !/^[0-9a-f]{64}$/.test(s.sourceSha256) ||
      !/^[1-9]\d*$/.test(s.retailerAccountId) || !/^\d{4}-\d\d-\d\dT.+(?:Z|[+-]\d\d:\d\d)$/.test(s.startedAt) || !Number.isFinite(Date.parse(s.startedAt)) ||
      !['RUNNING', 'PAUSED', 'READY', 'COMPLETE'].includes(s.status) || !Array.isArray(s.deals) || !s.deals.length || s.deals.length > 100 ||
      (s.messageType === 'SINGLE_DEAL' ? s.deals.length !== 1 : s.deals.length < 2) ||
      new Set(s.deals.map(d => d.dealUrl)).size !== s.deals.length) throw new Error('Invalid durable email workflow.');
  for (const d of s.deals) {
    if (!d || !isTrustedBfmrDealUrl(d.dealUrl) || !DEAL_STEPS.includes(d.step) ||
        (d.reference && (!d.reference.reserveId || !d.reference.dealId || d.dealId !== d.reference.dealId)) ||
        (!['PENDING', 'RESERVING', 'SKIPPED'].includes(d.step) && !d.reference) ||
        (d.cartNeedsReview !== undefined && typeof d.cartNeedsReview !== 'boolean') ||
        (d.cancelReason !== undefined && !['SUPPLIER_ABSENT', 'CHECKOUT_RULE'].includes(d.cancelReason))) throw new Error('Invalid per-reservation workflow identity.');
    if (d.targetAsin !== undefined && !/^[A-Z0-9]{10}$/.test(d.targetAsin)) throw new Error('Invalid workflow cart identity.');
    if (d.checkout && (!/^[A-Z0-9]{10}$/.test(d.checkout.asin) || !Number.isSafeInteger(d.checkout.totalCents) ||
        d.checkout.totalCents <= 0 || d.checkout.totalCents > 10000 || !Number.isSafeInteger(d.checkout.payoutCents) ||
        d.checkout.payoutCents < d.checkout.totalCents || d.checkout.productUrl !== `https://www.amazon.com/dp/${d.checkout.asin}`)) {
      throw new Error('Invalid locked checkout intent.');
    }
    if (['CHECKOUT_INTENT', 'ORDER_CONFIRMED', 'ORDER_RECORDED', 'PURCHASE_UPDATE_INTENT', 'COMPLETE'].includes(d.step) && !d.checkout) {
      throw new Error('Workflow checkout evidence is missing.');
    }
    if (d.order) {
      validateAmazonOrderRecord(d.order);
      if (!d.checkout || d.order.reserveId !== d.reference?.reserveId || d.order.dealId !== d.dealId ||
          d.order.asin !== d.checkout.asin || d.order.totalCents !== d.checkout.totalCents ||
          d.order.status !== 'PENDING' || d.order.packages.length !== 0 ||
          Date.parse(d.order.purchasedAt) < Date.parse(s.startedAt) || Date.parse(d.order.purchasedAt) > Date.now()) throw new Error('Workflow order identity conflicts.');
    }
    if (['ORDER_CONFIRMED', 'ORDER_RECORDED', 'PURCHASE_UPDATE_INTENT', 'COMPLETE'].includes(d.step) && !d.order) {
      throw new Error('Workflow causal order identity is missing.');
    }
  }
  if (s.status === 'COMPLETE' && !s.deals.every(terminalDeal)) throw new Error('Incomplete reservations cannot complete an email.');
  return s;
}

const transitions: Record<DealStep, readonly DealStep[]> = {
  PENDING: ['RESERVING'], RESERVING: ['RESERVING', 'RESERVED', 'SKIPPED'], RESERVED: ['EVALUATING'],
  EVALUATING: ['ELIGIBLE', 'CANCEL_INTENT'], ELIGIBLE: ['CHECKOUT_PREPARING'],
  CHECKOUT_PREPARING: ['CHECKOUT_INTENT', 'CANCEL_INTENT'], CHECKOUT_INTENT: ['ORDER_CONFIRMED'],
  ORDER_CONFIRMED: ['ORDER_RECORDED'], ORDER_RECORDED: ['PURCHASE_UPDATE_INTENT'], PURCHASE_UPDATE_INTENT: ['COMPLETE'],
  CANCEL_INTENT: ['CANCELLED'], COMPLETE: [], CANCELLED: [], SKIPPED: [],
};
function sameIdentity(before: DealEmailState, after: DealEmailState) {
  for (const key of ['schemaVersion', 'workflowId', 'account', 'source', 'messageId', 'messageType', 'sourceSha256', 'retailerAccountId', 'startedAt'] as const) {
    if (before[key] !== after[key]) throw new Error('Workflow identity cannot change.');
  }
  if (before.deals.length !== after.deals.length || before.deals.some((d, i) => d.dealUrl !== after.deals[i].dealUrl)) {
    throw new Error('Workflow announced deal set cannot change.');
  }
  before.deals.forEach((d, i) => {
    const next = after.deals[i];
    if (d.targetAsin && d.targetAsin !== next.targetAsin || d.dealId && d.dealId !== next.dealId || d.reference && canonicalWorkflowJson(d.reference) !== canonicalWorkflowJson(next.reference) ||
        d.checkout && canonicalWorkflowJson(d.checkout) !== canonicalWorkflowJson(next.checkout) || d.order &&
        (!next.order || d.order.orderId !== next.order.orderId || d.order.purchasedAt !== next.order.purchasedAt)) {
      throw new Error('Established workflow action identity cannot change.');
    }
  });
}

export class DealEmailWorkflowStore {
  constructor(readonly db: RelationalDatabase, readonly account: string) {}
  private async read(tx: BusinessRepositories, source: string, messageId: string,
    forReconciliation = false): Promise<WorkflowCheckpoint | null> {
    const result = await tx.query<{ id: string; correlation_id: string; phase: string; evidence: JsonObject }>(`SELECT id::text,correlation_id,phase,evidence FROM public.workflow_evidence
      WHERE action_type=$1 AND evidence->>'account'=$2 AND evidence->>'source'=$3 AND evidence->>'messageId'=$4
      ORDER BY id DESC LIMIT $5`, [EMAIL_WORKFLOW_ACTION, this.account, source, messageId, forReconciliation ? 2 : 1]);
    const row = result.rows[0];
    if (!row) return null;
    try { return { revision: row.id, state: validateDealEmailState(row.evidence) }; }
    catch (error) {
      if (!forReconciliation) throw error;
      // The former bulk-unblock script copied the immediately preceding state
      // and replaced only status with COMPLETE. Never invent missing history or
      // discard any action fields; normal load/claim still reject this state.
      const previous = result.rows[1];
      if (source !== 'GMAIL' || row.phase !== 'SNAPSHOT' || row.evidence.status !== 'COMPLETE' ||
          !previous || previous.phase !== 'SNAPSHOT' || previous.correlation_id !== row.correlation_id) {
        throw new LegacyWorkflowSnapshotError();
      }
      let prior: DealEmailState;
      try { prior = validateDealEmailState(previous.evidence); }
      catch { throw new LegacyWorkflowSnapshotError(); }
      if (prior.status === 'COMPLETE' || prior.account !== this.account || prior.messageId !== messageId ||
          prior.source !== 'GMAIL' || prior.workflowId !== row.correlation_id ||
          canonicalWorkflowJson({ ...row.evidence, status: prior.status }) !== canonicalWorkflowJson(previous.evidence)) {
        throw new LegacyWorkflowSnapshotError();
      }
      return { revision: row.id, state: validateDealEmailState({ ...structuredClone(prior), status: 'PAUSED' }),
        legacyStatusOverride: { predecessorRevision: previous.id,
          invalidSnapshotSha256: createHash('sha256').update(canonicalWorkflowJson(row.evidence)).digest('hex') } };
    }
  }
  async load(source: string, messageId: string): Promise<WorkflowCheckpoint | null> {
    return this.db.withTransaction(tx => this.read(tx, source, messageId));
  }
  /** Read-only recovery interpretation, never available to worker claim/save. */
  async loadForReconciliation(messageId: string): Promise<WorkflowCheckpoint | null> {
    return this.db.withTransaction(tx => this.read(tx, 'GMAIL', messageId, true));
  }
  async assertNoUnfinished(): Promise<void> {
    const result = await this.db.withTransaction(tx => tx.query(`SELECT id FROM (
      SELECT DISTINCT ON (correlation_id) id,evidence FROM public.workflow_evidence
      WHERE action_type=$1 AND evidence->>'account'=$2 ORDER BY correlation_id,id DESC
      ) latest WHERE COALESCE(evidence->>'status','') NOT IN ('COMPLETE','READY') LIMIT 1`, [EMAIL_WORKFLOW_ACTION, this.account]));
    if (result.rows.length) throw new Error('Unfinished email workflow requires a fresh reconciliation report and reviewed repair before startup.');
  }
  private async append(tx: BusinessRepositories, state: DealEmailState): Promise<WorkflowCheckpoint> {
    validateDealEmailState(state);
    const row = await tx.evidence.appendWorkflow({ correlationId: state.workflowId, actionType: EMAIL_WORKFLOW_ACTION,
      phase: 'SNAPSHOT', outcome: state.status, evidence: JSON.parse(JSON.stringify(state)) as JsonObject });
    return { revision: row.id, state: structuredClone(state) };
  }
  async claim(email: WorkflowEmail, messageType: DealEmailState['messageType'], dealUrls: string[], retailerAccountId: string): Promise<WorkflowCheckpoint> {
    return this.db.withTransaction(async tx => {
      if (email.source !== 'LOCAL_PDF_TEST') {
        const work = await tx.query<{ state: string; payload: WorkflowEmail | null }>(`SELECT state,payload FROM public.gmail_intake_work
          WHERE account_namespace=$1 AND gmail_message_id=$2 FOR UPDATE`, [this.account, email.id]);
        if (work.rows.length !== 1 || work.rows[0].state !== 'PROCESSING' || !work.rows[0].payload ||
            emailSourceSha256(work.rows[0].payload) !== emailSourceSha256(email)) {
          throw new Error('Only the exact currently PROCESSING Gmail payload can enter purchasing; completed/historical mail cannot be enrolled.');
        }
      }
      const unfinished = await tx.query(`SELECT id FROM (
        SELECT DISTINCT ON (correlation_id) id,evidence FROM public.workflow_evidence
        WHERE action_type=$1 AND evidence->>'account'=$2 ORDER BY correlation_id,id DESC
        ) latest WHERE COALESCE(evidence->>'status','')<>'COMPLETE'
        AND (evidence->>'messageId' IS DISTINCT FROM $3 OR evidence->>'source' IS DISTINCT FROM $4) LIMIT 1`,
      [EMAIL_WORKFLOW_ACTION, this.account, email.id, email.source ?? 'GMAIL']);
      if (unfinished.rows.length) throw new Error('Another account workflow is unfinished; reconcile it before new work.');
      const previous = await this.read(tx, email.source ?? 'GMAIL', email.id);
      if (previous) {
        if (previous.state.sourceSha256 !== emailSourceSha256(email) || previous.state.retailerAccountId !== retailerAccountId ||
            previous.state.messageType !== messageType || JSON.stringify(previous.state.deals.map(d => d.dealUrl)) !== JSON.stringify(dealUrls)) {
          throw new Error('Existing workflow source/account/deal identity conflicts.');
        }
        if (previous.state.status === 'COMPLETE') return previous;
        if (previous.state.status !== 'READY') throw new Error('Interrupted workflow cannot be automatically re-entered.');
        return this.append(tx, { ...previous.state, status: 'RUNNING' });
      }
      if (await tx.emails.findByGmailId(email.id)) throw new Error('Previously recorded mail cannot be backfilled into the new purchase workflow.');
      if (email.source !== 'LOCAL_PDF_TEST') await tx.emails.upsert({ gmailMessageId: email.id, subject: email.subject, receivedAt: email.receivedAt, emailType: messageType });
      return this.append(tx, { schemaVersion: 1, workflowId: randomUUID(), account: this.account,
        source: email.source ?? 'GMAIL', messageId: email.id, sourceSha256: emailSourceSha256(email), messageType, retailerAccountId,
        startedAt: new Date().toISOString(), status: 'RUNNING', deals: dealUrls.map(dealUrl => ({ dealUrl, step: 'PENDING' })) });
    });
  }
  async save(checkpoint: WorkflowCheckpoint, next: DealEmailState): Promise<WorkflowCheckpoint> {
    return this.db.withTransaction(async tx => {
      const current = await this.read(tx, checkpoint.state.source, checkpoint.state.messageId);
      if (!current || current.revision !== checkpoint.revision || current.state.status !== 'RUNNING' ||
          !['RUNNING', 'PAUSED', 'COMPLETE'].includes(next.status)) throw new Error('Workflow snapshot changed; no retry is permitted.');
      sameIdentity(current.state, next);
      next.deals.forEach((d, i) => {
        const old = current.state.deals[i];
        if (old.step !== d.step && !transitions[old.step].includes(d.step)) throw new Error('Illegal workflow action transition.');
      });
      return this.append(tx, next);
    });
  }
  private async repairAlreadyAppliedInTransaction(tx: BusinessRepositories, next: DealEmailState, hash: string): Promise<boolean> {
    validateDealEmailState(next);
    if (next.account !== this.account || next.source !== 'GMAIL' || !/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid repair identity.');
    const receipt = await tx.query(`SELECT id FROM public.workflow_evidence WHERE action_type='DEAL_EMAIL_REPAIR'
      AND phase='APPLIED' AND correlation_id=$1 AND evidence->>'account'=$2 AND evidence->>'message_id'=$3
      AND evidence->>'report_sha256'=$4 AND evidence->>'state_sha256'=$5 LIMIT 1`,
    [next.workflowId, this.account, next.messageId, hash, createHash('sha256').update(canonicalWorkflowJson(next)).digest('hex')]);
    if (!receipt.rows.length) return false;
    // A committed receipt proves this exact repair happened. Do not replay it,
    // even if a later authorized worker has advanced the workflow/queue again.
    return true;
  }
  async repairAlreadyApplied(next: DealEmailState, hash: string): Promise<boolean> {
    return this.db.withTransaction(tx => this.repairAlreadyAppliedInTransaction(tx, next, hash));
  }
  /** Only a caller with a freshly regenerated provider report may use this path.
   * The transaction callback repairs local records only; never provider effects.
   */
  async applyReviewedRepair(checkpoint: WorkflowCheckpoint, next: DealEmailState, reportSha256: string,
    repairLocalRecords: (tx: BusinessRepositories) => Promise<void>): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(reportSha256)) throw new Error('Exact reviewed reconciliation report hash is required.');
    await this.db.withTransaction(async tx => {
      await assertIntakePrivileges(tx);
      if (await this.repairAlreadyAppliedInTransaction(tx, next, reportSha256)) return;
      const current = await this.read(tx, checkpoint.state.source, checkpoint.state.messageId, Boolean(checkpoint.legacyStatusOverride));
      if (canonicalWorkflowJson(current?.legacyStatusOverride ?? null) !== canonicalWorkflowJson(checkpoint.legacyStatusOverride ?? null)) {
        throw new Error('Workflow recovery provenance changed; regenerate the report.');
      }
      if (!current || current.revision !== checkpoint.revision || (current.state.status === 'COMPLETE' && next.status !== 'COMPLETE') ||
          next.source !== 'GMAIL' || !['READY', 'COMPLETE'].includes(next.status)) throw new Error('Workflow repair no longer matches the reviewed state.');
      sameIdentity(current.state, next);
      const work = await tx.query<{ state: string; payload: WorkflowEmail | null }>(`SELECT state,payload FROM public.gmail_intake_work
        WHERE account_namespace=$1 AND gmail_message_id=$2 FOR UPDATE`, [this.account, next.messageId]);
      if (work.rows.length !== 1 || work.rows[0].state !== 'PROCESSING' || !work.rows[0].payload ||
          emailSourceSha256(work.rows[0].payload) !== next.sourceSha256) throw new Error('Completed, missing or changed Gmail work cannot be repaired/replayed.');
      await repairLocalRecords(tx);
      await this.append(tx, next);
      const changed = await tx.query(`UPDATE public.gmail_intake_work SET state=$3,payload=CASE WHEN $3='DONE' THEN NULL ELSE payload END,updated_at=now()
        WHERE account_namespace=$1 AND gmail_message_id=$2 AND state='PROCESSING'`,
      [this.account, next.messageId, next.status === 'COMPLETE' ? 'DONE' : 'PENDING']);
      if (changed.rowCount !== 1) throw new Error('Gmail work changed during repair; all local changes rolled back.');
      const incidents = await tx.query<{ id: string }>(`SELECT id::text FROM public.workflow_evidence
        WHERE action_type='WORKER_ACTION_CONTROL' AND phase='BLOCKED' AND outcome='EMAIL_ACTION_REQUIRES_REVIEW'
        AND evidence->>'account'=$1 AND evidence->>'workflow_id'=$2
        AND NOT EXISTS (SELECT 1 FROM public.workflow_evidence resolved WHERE resolved.action_type='WORKER_ACTION_CONTROL'
          AND resolved.phase='RESOLVED' AND resolved.evidence->>'account'=$1
          AND resolved.evidence->>'blocked_event_id'=workflow_evidence.id::text)`, [this.account, next.workflowId]);
      for (const incident of incidents.rows) await tx.evidence.appendWorkflow({ correlationId: next.workflowId,
        actionType: 'WORKER_ACTION_CONTROL', phase: 'RESOLVED', outcome: 'REVIEWED', evidence: {
          account: this.account, workflow_id: next.workflowId, blocked_event_id: incident.id, review_source_sha256: reportSha256 } });
      await tx.evidence.appendWorkflow({ correlationId: next.workflowId, actionType: 'DEAL_EMAIL_REPAIR',
        phase: 'APPLIED', outcome: next.status, evidence: { account: this.account, message_id: next.messageId,
          report_sha256: reportSha256,
          ...(current.legacyStatusOverride ? { legacy_status_override: { ...current.legacyStatusOverride } } : {}),
          state_sha256: createHash('sha256').update(canonicalWorkflowJson(next)).digest('hex') } });
    });
  }
}
