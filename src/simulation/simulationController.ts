import { SimulatedStore } from './simulatedStore';
import { SCENARIO_CATALOG } from './scenarioCatalog';
import { createSimulatedProviderBundle } from './simulatedBundle';
import { createSimulationAppRuntime } from './appRuntimeFixture';
import { StateReconciler } from './reconciler';
import { processEmail, WorkflowReviewRequiredError, type ReceivedEmail } from '../services/dealEmailWorkflow';
import type { ProviderBundle } from '../providers/interfaces';
import type { RelationalRuntime } from '../services/relationalRuntime';
import type {
  ScenarioDefinition,
  SimulationRunRecord,
  StateComparisonDiff,
} from './types';

interface ActiveRunContext {
  runId: string;
  scenario: ScenarioDefinition;
  bundle: ProviderBundle;
  appRuntime: RelationalRuntime;
  email: ReceivedEmail;
}

export class SimulationController {
  private readonly store: SimulatedStore;
  private readonly reconciler: StateReconciler;
  private activeRuns: Map<string, ActiveRunContext> = new Map();

  constructor() {
    this.store = new SimulatedStore();
    this.reconciler = new StateReconciler(this.store);
  }

  public async init(): Promise<void> {
    await this.store.init();
  }

  public listScenarios(): ScenarioDefinition[] {
    return SCENARIO_CATALOG;
  }

  public getScenario(scenarioId: string): ScenarioDefinition | undefined {
    return SCENARIO_CATALOG.find((s) => s.id === scenarioId);
  }

  public async createRun(scenarioId: string): Promise<SimulationRunRecord> {
    await this.init();
    const scenario = this.getScenario(scenarioId);
    if (!scenario) throw new Error(`Scenario not found: ${scenarioId}`);

    const runId = `RUN-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000)}`;

    const runRecord = await this.store.createRun(scenario, runId);
    const bundle = createSimulatedProviderBundle(this.store, runId, {
      accountId: 'synthetic-operator-1',
      initialTime: new Date(runRecord.virtualTime),
    });

    const appRuntime = await createSimulationAppRuntime({
      account: 'synthetic-operator-1',
      retailerEmail: 'buyer@example.invalid',
    });

    const email: ReceivedEmail = {
      id: `msg-${runId.toLowerCase()}`,
      sender: scenario.sampleEmail.sender,
      subject: scenario.sampleEmail.subject,
      body: scenario.sampleEmail.body,
      inboxAtFetch: true,
      receivedAt: new Date(runRecord.createdAt).toISOString(),
      headers: [
        { name: 'From', value: scenario.sampleEmail.sender },
        { name: 'Received', value: 'from mail.example by mx.google.com with ESMTPS' },
        { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=buyformeretail.com; dkim=pass header.d=buyformeretail.com' },
      ],
    };

    this.activeRuns.set(runId, {
      runId,
      scenario,
      bundle,
      appRuntime,
      email,
    });

    return this.store.getRun(runId);
  }

  public async getRun(runId: string): Promise<SimulationRunRecord> {
    return this.store.getRun(runId);
  }

  public async executeWorkflow(runId: string): Promise<{
    run: SimulationRunRecord;
    diff: StateComparisonDiff;
    error?: string;
  }> {
    const ctx = this.activeRuns.get(runId);
    if (!ctx) throw new Error(`Active run context not found for ${runId}.`);

    const existingRun = await this.store.getRun(runId);
    if (existingRun.status === 'COMPLETED') {
      const diff = await this.reconciler.evaluateDiff(runId, ctx.appRuntime.db);
      return { run: existingRun, diff };
    }

    await this.store.updateRunStatus(runId, 'RUNNING');
    await this.store.logEvent(runId, 'INFO', 'WORKFLOW', `Starting workflow execution for scenario: ${ctx.scenario.name}`);

    // Set BFMR_INTAKE_MODE to testing and BFMR_PROVIDER_MODE to simulation
    const originalIntake = process.env.BFMR_INTAKE_MODE;
    const originalProvider = process.env.BFMR_PROVIDER_MODE;
    const originalExposure = process.env.BFMR_OPEN_EXPOSURE_CONTRACT_VALIDATED;
    const originalTerms = process.env.BFMR_CREATION_TERMS_CONTRACT_VALIDATED;
    process.env.BFMR_INTAKE_MODE = 'testing';
    process.env.BFMR_PROVIDER_MODE = 'simulation';
    process.env.BFMR_OPEN_EXPOSURE_CONTRACT_VALIDATED = 'YES';
    process.env.BFMR_CREATION_TERMS_CONTRACT_VALIDATED = 'YES';

    let errorDetail: string | undefined;

    try {
      const email = ctx.email;

      // Enroll message in gmail_intake_work per CON-001 requirements
      const { createHash } = await import('node:crypto');
      const sha256 = createHash('sha256').update(JSON.stringify(email)).digest('hex');
      await ctx.appRuntime.db.withTransaction(async (tx) => {
        await tx.query(
          `INSERT INTO public.gmail_intake_work (account_namespace, gmail_message_id, state, payload, payload_sha256, received_at)
           VALUES ($1, $2, 'PROCESSING', $3, $4, now())
           ON CONFLICT (account_namespace, gmail_message_id) DO UPDATE SET state = 'PROCESSING', payload = EXCLUDED.payload`,
          [ctx.appRuntime.account, email.id, JSON.stringify(email), sha256]
        );
      });

      await processEmail(
        email,
        ctx.bundle,
        ctx.appRuntime,
        async () => {} // Assertion guard passes in controlled simulation
      );

      await this.store.updateRunStatus(runId, 'COMPLETED');
      await this.store.logEvent(runId, 'INFO', 'WORKFLOW', `Workflow completed successfully.`);
    } catch (err: any) {
      if (err instanceof WorkflowReviewRequiredError) {
        const causeMsg = (err as any).causeError?.message ? ` (Reason: ${(err as any).causeError.message})` : '';
        errorDetail = `Workflow paused: review required for workflowId ${err.workflowId}${causeMsg}.`;
        await this.store.updateRunStatus(runId, 'PAUSED');
        await this.store.logEvent(runId, 'WARN', 'WORKFLOW', errorDetail);
      } else {
        errorDetail = err?.message || String(err);
        await this.store.updateRunStatus(runId, 'FAILED');
        await this.store.logEvent(runId, 'ERROR', 'WORKFLOW', `Workflow failed: ${errorDetail}`);
      }
    } finally {
      process.env.BFMR_INTAKE_MODE = originalIntake;
      process.env.BFMR_PROVIDER_MODE = originalProvider;
      process.env.BFMR_OPEN_EXPOSURE_CONTRACT_VALIDATED = originalExposure;
      process.env.BFMR_CREATION_TERMS_CONTRACT_VALIDATED = originalTerms;
    }

    const diff = await this.reconciler.evaluateDiff(runId, ctx.appRuntime.db);
    const run = await this.store.getRun(runId);

    return { run, diff, error: errorDetail };
  }

  public async getDiff(runId: string): Promise<StateComparisonDiff> {
    const ctx = this.activeRuns.get(runId);
    if (!ctx) throw new Error(`Active run context not found for ${runId}.`);
    return this.reconciler.evaluateDiff(runId, ctx.appRuntime.db);
  }

  public async advanceTime(runId: string, seconds: number): Promise<string> {
    return this.store.advanceTime(runId, seconds);
  }

  public async close(): Promise<void> {
    for (const ctx of this.activeRuns.values()) {
      await ctx.appRuntime.close().catch(() => {});
    }
    this.activeRuns.clear();
    await this.store.close();
  }
}

export const simulationController = new SimulationController();
