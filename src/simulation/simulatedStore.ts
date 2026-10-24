import { PGlite } from '@electric-sql/pglite';
import type {
  ScenarioDefinition,
  SimulatedDeal,
  SimulatedReservation,
  ScriptedFault,
  SimulationRunRecord,
} from './types';

export class SimulatedStore {
  private pglite: PGlite | null = null;
  private initPromise: Promise<void> | null = null;

  constructor() {}

  public async init(): Promise<void> {
    if (this.pglite) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      this.pglite = await PGlite.create();
      await this.pglite.exec(`
        CREATE TABLE IF NOT EXISTS sim_runs (
          run_id TEXT PRIMARY KEY,
          scenario_id TEXT NOT NULL,
          scenario_name TEXT NOT NULL,
          phase INT NOT NULL,
          status TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          virtual_time TIMESTAMPTZ NOT NULL,
          step_count INT NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS sim_deals (
          run_id TEXT NOT NULL,
          deal_id TEXT NOT NULL,
          slug TEXT NOT NULL,
          title TEXT NOT NULL,
          deal_url TEXT NOT NULL,
          retailer TEXT NOT NULL,
          is_closed BOOLEAN NOT NULL DEFAULT FALSE,
          available_slots INT NOT NULL DEFAULT 10,
          payout_cents INT NOT NULL,
          retail_cents INT NOT NULL,
          asin TEXT,
          PRIMARY KEY (run_id, deal_id)
        );

        CREATE TABLE IF NOT EXISTS sim_reservations (
          run_id TEXT NOT NULL,
          reserve_id TEXT NOT NULL,
          deal_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          quantity INT NOT NULL DEFAULT 1,
          status TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (run_id, reserve_id)
        );

        CREATE TABLE IF NOT EXISTS sim_fault_rules (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          target_op TEXT NOT NULL,
          fault_type TEXT NOT NULL,
          trigger_on_attempt INT NOT NULL DEFAULT 1,
          current_attempt INT NOT NULL DEFAULT 0,
          triggered BOOLEAN NOT NULL DEFAULT FALSE,
          error_detail TEXT
        );

        CREATE TABLE IF NOT EXISTS sim_events (
          id SERIAL PRIMARY KEY,
          run_id TEXT NOT NULL,
          timestamp TIMESTAMPTZ NOT NULL,
          level TEXT NOT NULL,
          category TEXT NOT NULL,
          message TEXT NOT NULL,
          details JSONB
        );
      `);
    })();

    return this.initPromise;
  }

  private get db(): PGlite {
    if (!this.pglite) throw new Error('SimulatedStore not initialized. Call init() first.');
    return this.pglite;
  }

  public async createRun(scenario: ScenarioDefinition, runId: string): Promise<SimulationRunRecord> {
    await this.init();
    const now = new Date().toISOString();

    await this.db.query(
      `INSERT INTO sim_runs (run_id, scenario_id, scenario_name, phase, status, created_at, virtual_time, step_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
      [runId, scenario.id, scenario.name, scenario.phase, 'IDLE', now, now]
    );

    for (const deal of scenario.initialDeals) {
      await this.db.query(
        `INSERT INTO sim_deals (run_id, deal_id, slug, title, deal_url, retailer, is_closed, available_slots, payout_cents, retail_cents, asin)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          runId,
          deal.dealId,
          deal.slug,
          deal.title,
          deal.dealUrl,
          deal.retailer,
          deal.isClosed,
          deal.availableSlots,
          deal.payoutCents,
          deal.retailCents,
          deal.asin ?? null,
        ]
      );
    }

    if (scenario.initialReservations) {
      for (const res of scenario.initialReservations) {
        await this.db.query(
          `INSERT INTO sim_reservations (run_id, reserve_id, deal_id, account_id, quantity, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [runId, res.reserveId, res.dealId, res.accountId, res.quantity, res.status, res.createdAt || now]
        );
      }
    }

    if (scenario.faults) {
      for (const fault of scenario.faults) {
        await this.db.query(
          `INSERT INTO sim_fault_rules (id, run_id, target_op, fault_type, trigger_on_attempt, current_attempt, triggered, error_detail)
           VALUES ($1, $2, $3, $4, $5, 0, FALSE, $6)`,
          [fault.id, runId, fault.targetOp, fault.faultType, fault.triggerOnAttempt, fault.errorDetail ?? null]
        );
      }
    }

    await this.logEvent(runId, 'INFO', 'SYSTEM', `Run created for scenario: ${scenario.name} (${runId})`);

    return this.getRun(runId);
  }

  public async getRun(runId: string): Promise<SimulationRunRecord> {
    await this.init();
    const runRes = await this.db.query<{
      run_id: string;
      scenario_id: string;
      scenario_name: string;
      phase: number;
      status: string;
      created_at: string;
      virtual_time: string;
      step_count: number;
    }>('SELECT * FROM sim_runs WHERE run_id = $1', [runId]);

    if (runRes.rows.length === 0) throw new Error(`Run ${runId} not found.`);
    const r = runRes.rows[0];

    const faultsRes = await this.db.query<{
      id: string;
      target_op: string;
      fault_type: string;
      trigger_on_attempt: number;
      error_detail: string | null;
    }>('SELECT * FROM sim_fault_rules WHERE run_id = $1', [runId]);

    const logsRes = await this.db.query<{
      timestamp: string;
      level: string;
      category: string;
      message: string;
      details: unknown;
    }>('SELECT * FROM sim_events WHERE run_id = $1 ORDER BY id ASC', [runId]);

    return {
      runId: r.run_id,
      scenarioId: r.scenario_id,
      scenarioName: r.scenario_name,
      phase: r.phase as any,
      status: r.status as any,
      createdAt: r.created_at,
      virtualTime: r.virtual_time,
      stepCount: r.step_count,
      activeFaults: faultsRes.rows.map((f) => ({
        id: f.id,
        targetOp: f.target_op as any,
        faultType: f.fault_type as any,
        triggerOnAttempt: f.trigger_on_attempt,
        errorDetail: f.error_detail ?? undefined,
      })),
      logs: logsRes.rows.map((l) => ({
        timestamp: l.timestamp,
        level: l.level as any,
        category: l.category as any,
        message: l.message,
        details: l.details,
      })),
    };
  }

  public async updateRunStatus(runId: string, status: SimulationRunRecord['status']): Promise<void> {
    await this.init();
    await this.db.query('UPDATE sim_runs SET status = $1 WHERE run_id = $2', [status, runId]);
  }

  public async advanceTime(runId: string, seconds: number): Promise<string> {
    await this.init();
    const run = await this.getRun(runId);
    const newTime = new Date(new Date(run.virtualTime).getTime() + seconds * 1000).toISOString();
    await this.db.query('UPDATE sim_runs SET virtual_time = $1 WHERE run_id = $2', [newTime, runId]);
    await this.logEvent(runId, 'INFO', 'SYSTEM', `Advanced virtual time by ${seconds}s to ${newTime}`);
    return newTime;
  }

  public async getDeals(runId: string): Promise<SimulatedDeal[]> {
    await this.init();
    const res = await this.db.query<{
      deal_id: string;
      slug: string;
      title: string;
      deal_url: string;
      retailer: string;
      is_closed: boolean;
      available_slots: number;
      payout_cents: number;
      retail_cents: number;
      asin: string | null;
    }>('SELECT * FROM sim_deals WHERE run_id = $1', [runId]);

    return res.rows.map((d) => ({
      dealId: d.deal_id,
      slug: d.slug,
      title: d.title,
      dealUrl: d.deal_url,
      retailer: d.retailer,
      isClosed: d.is_closed,
      availableSlots: d.available_slots,
      payoutCents: d.payout_cents,
      retailCents: d.retail_cents,
      asin: d.asin ?? undefined,
    }));
  }

  public async getDealBySlug(runId: string, slug: string): Promise<SimulatedDeal | null> {
    const deals = await this.getDeals(runId);
    return deals.find((d) => d.slug.toLowerCase() === slug.toLowerCase() || d.dealUrl.endsWith(slug)) ?? null;
  }

  public async getDealById(runId: string, dealId: string): Promise<SimulatedDeal | null> {
    const deals = await this.getDeals(runId);
    return deals.find((d) => d.dealId === dealId) ?? null;
  }

  public async getReservations(runId: string): Promise<SimulatedReservation[]> {
    await this.init();
    const res = await this.db.query<{
      reserve_id: string;
      deal_id: string;
      account_id: string;
      quantity: number;
      status: string;
      created_at: string;
    }>('SELECT * FROM sim_reservations WHERE run_id = $1 ORDER BY created_at DESC', [runId]);

    return res.rows.map((r) => ({
      reserveId: r.reserve_id,
      dealId: r.deal_id,
      accountId: r.account_id,
      quantity: r.quantity,
      status: r.status as any,
      createdAt: r.created_at,
    }));
  }

  public async createReservation(
    runId: string,
    dealId: string,
    accountId: string,
    quantity: number = 1
  ): Promise<SimulatedReservation> {
    await this.init();
    const reserveId = `sim-res-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
    const now = new Date().toISOString();

    await this.db.query(
      `INSERT INTO sim_reservations (run_id, reserve_id, deal_id, account_id, quantity, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'reserved', $6)`,
      [runId, reserveId, dealId, accountId, quantity, now]
    );

    await this.db.query(
      `UPDATE sim_deals SET available_slots = GREATEST(0, available_slots - $1) WHERE run_id = $2 AND deal_id = $3`,
      [quantity, runId, dealId]
    );

    await this.logEvent(runId, 'INFO', 'PROVIDER', `Simulated reservation created: ${reserveId} for deal ${dealId} (qty ${quantity})`);

    return {
      reserveId,
      dealId,
      accountId,
      quantity,
      status: 'reserved',
      createdAt: now,
    };
  }

  public async cancelReservation(runId: string, reserveId: string): Promise<boolean> {
    await this.init();
    const res = await this.db.query(
      `UPDATE sim_reservations SET status = 'cancelled' WHERE run_id = $1 AND reserve_id = $2 AND status = 'reserved'`,
      [runId, reserveId]
    );
    const affected = (res as any).affectedRows ?? (res as any).rowCount ?? 0;
    if (affected > 0) {
      await this.logEvent(runId, 'INFO', 'PROVIDER', `Simulated reservation cancelled: ${reserveId}`);
      return true;
    }
    return false;
  }

  /**
   * Check and increment attempt count for a target operation.
   * Returns a matching fault if the fault triggers on this attempt.
   */
  public async checkAndTriggerFault(
    runId: string,
    targetOp: ScriptedFault['targetOp']
  ): Promise<ScriptedFault | null> {
    await this.init();
    const faultsRes = await this.db.query<{
      id: string;
      target_op: string;
      fault_type: string;
      trigger_on_attempt: number;
      current_attempt: number;
      triggered: boolean;
      error_detail: string | null;
    }>(
      `SELECT * FROM sim_fault_rules WHERE run_id = $1 AND target_op = $2 AND triggered = FALSE`,
      [runId, targetOp]
    );

    if (faultsRes.rows.length === 0) return null;

    const faultRow = faultsRes.rows[0];
    const newAttempt = faultRow.current_attempt + 1;

    if (newAttempt >= faultRow.trigger_on_attempt) {
      await this.db.query(
        `UPDATE sim_fault_rules SET current_attempt = $1, triggered = TRUE WHERE id = $2`,
        [newAttempt, faultRow.id]
      );
      await this.logEvent(
        runId,
        'WARN',
        'PROVIDER',
        `Fault triggered: ${faultRow.fault_type} on ${targetOp} (attempt ${newAttempt})`
      );
      return {
        id: faultRow.id,
        targetOp: faultRow.target_op as any,
        faultType: faultRow.fault_type as any,
        triggerOnAttempt: faultRow.trigger_on_attempt,
        errorDetail: faultRow.error_detail ?? undefined,
      };
    } else {
      await this.db.query(
        `UPDATE sim_fault_rules SET current_attempt = $1 WHERE id = $2`,
        [newAttempt, faultRow.id]
      );
      return null;
    }
  }

  public async logEvent(
    runId: string,
    level: 'INFO' | 'WARN' | 'ERROR',
    category: 'PROVIDER' | 'WORKFLOW' | 'TELEGRAM' | 'SYSTEM',
    message: string,
    details?: unknown
  ): Promise<void> {
    await this.init();
    await this.db.query(
      `INSERT INTO sim_events (run_id, timestamp, level, category, message, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [runId, new Date().toISOString(), level, category, message, details ? JSON.stringify(details) : null]
    );
  }

  public async close(): Promise<void> {
    if (this.pglite) {
      await this.pglite.close();
      this.pglite = null;
      this.initPromise = null;
    }
  }
}
