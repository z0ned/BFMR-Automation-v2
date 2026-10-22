import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { RelationalDatabase } from '../db/relationalDatabase';
import type { JsonObject } from '../db/relationalTypes';

export interface RecoveryFileState { path: string; present: boolean; unresolved: boolean }

/** Uses existing append-only evidence, not the legacy engine's separate gates.
 * A restart/notification success never clears an incident. Reviewed repair must
 * append a RESOLVED event referencing its exact blocked event, with provenance.
 */
export class WorkerActionControl {
  private stopped = false;
  private blockRecorded = false;
  constructor(private readonly db: RelationalDatabase, private readonly account: string) {}

  async assertReady(): Promise<void> {
    if (this.stopped) throw new Error('Worker action control is blocked; reconciliation is required.');
    const blocked = await this.db.withTransaction(async tx => tx.query(`
      SELECT b.id FROM public.workflow_evidence b
      WHERE b.action_type='WORKER_ACTION_CONTROL' AND b.phase='BLOCKED' AND b.evidence->>'account'=$1
      AND NOT EXISTS (SELECT 1 FROM public.workflow_evidence r
        WHERE r.action_type=b.action_type AND r.phase='RESOLVED' AND r.outcome='REVIEWED'
        AND r.id>b.id AND r.recorded_at>=b.recorded_at
        AND r.evidence->>'account'=$1 AND r.evidence->>'blocked_event_id'=b.id::text
        AND r.evidence->>'review_source_sha256' ~ '^[0-9a-f]{64}$') LIMIT 1`, [this.account]));
    if (blocked.rows.length) {
      this.stopped = true;
      throw new Error('An unresolved worker incident blocks new actions, including after restart.');
    }
  }

  async block(code: string, workflowId?: string): Promise<void> {
    // Set the local latch before awaiting storage. Failed persistence cannot
    // let the running worker continue or automatically repeat an external write.
    this.stopped = true;
    if (this.blockRecorded) return;
    if (!/^[A-Z][A-Z0-9_]*$/.test(code)) throw new Error('Invalid action-control reason.');
    await this.db.withTransaction(tx => tx.evidence.appendWorkflow({ correlationId: randomUUID(),
      actionType: 'WORKER_ACTION_CONTROL', phase: 'BLOCKED', outcome: code,
      evidence: { account: this.account, schemaVersion: 1, ...(workflowId ? { workflow_id: workflowId } : {}) } }));
    this.blockRecorded = true;
  }

  async auditRecovery(readFiles: () => Promise<Record<string, RecoveryFileState>>, acceptFirstBaseline = false): Promise<void> {
    await this.assertReady();
    const files = await readFiles();
    await this.db.withTransaction(async tx => {
      const prior = await tx.query<{ evidence: JsonObject }>(`SELECT evidence FROM public.workflow_evidence
        WHERE action_type='WORKER_RECOVERY_INVENTORY' AND evidence->>'account'=$1
        ORDER BY id DESC LIMIT 1`, [this.account]);
      if (!prior.rows.length && !acceptFirstBaseline) {
        throw new Error('Review and explicitly accept the initial recovery-file baseline before worker startup.');
      }
      const stored = prior.rows[0]?.evidence.files;
      if (prior.rows.length && (prior.rows[0].evidence.schemaVersion !== 1 || !stored || typeof stored !== 'object' || Array.isArray(stored))) {
        throw new Error('Recovery inventory evidence is invalid.');
      }
      const previous = stored as JsonObject | undefined;
      const observed: JsonObject = {};
      for (const [name, file] of Object.entries(files)) {
        const pathSha256 = createHash('sha256').update(resolve(file.path)).digest('hex');
        const old = previous && !Array.isArray(previous) && typeof previous === 'object' ? previous[name] : undefined;
        if (previous && (!old || typeof old !== 'object' || Array.isArray(old) ||
            old.pathSha256 !== pathSha256 || typeof old.present !== 'boolean' || old.present && !file.present)) {
          throw new Error('A recovery file is missing or its configured path changed; restore/reconcile first.');
        }
        if (file.unresolved) throw new Error('A recovery journal or pending alert requires reconciliation before new work.');
        observed[name] = { pathSha256, present: file.present };
      }
      if (previous && Object.keys(previous).length !== Object.keys(files).length) throw new Error('Recovery inventory scope changed.');
      if (previous && Object.keys(observed).every(name => {
        const old = previous[name], current = observed[name];
        return old && current && typeof old === 'object' && typeof current === 'object' &&
          !Array.isArray(old) && !Array.isArray(current) && old.pathSha256 === current.pathSha256 && old.present === current.present;
      })) return;
      await tx.evidence.appendWorkflow({ correlationId: randomUUID(), actionType: 'WORKER_RECOVERY_INVENTORY',
        phase: 'OBSERVED', outcome: 'READY', evidence: { account: this.account, schemaVersion: 1, files: observed } });
    });
  }

  async assertNoUncertainActions(): Promise<void> {
    await this.assertReady();
    const result = await this.db.withTransaction(tx => tx.query(`
      SELECT i.id FROM public.workflow_evidence i
      WHERE (i.action_type='AMAZON_CHECKOUT' AND i.phase='INTENT'
        AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.reservation_id=i.reservation_id))
      OR (i.action_type='RESERVATION_CREATION' AND i.phase='INTENT'
        AND NOT EXISTS (SELECT 1 FROM public.workflow_evidence c WHERE c.action_type=i.action_type
          AND c.id>i.id AND c.correlation_id=i.correlation_id AND c.phase IN ('CONFIRMED','NO_ACTION')
          AND c.evidence->>'bfmr_deal_id'=i.evidence->>'bfmr_deal_id')) LIMIT 1`));
    if (result.rows.length) throw new Error('Unresolved reservation or checkout intent requires authoritative reconciliation before startup.');
  }
}
