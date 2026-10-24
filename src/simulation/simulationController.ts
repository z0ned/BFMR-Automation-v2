import { SimulatedStore } from './simulatedStore';
import { SCENARIO_CATALOG } from './scenarioCatalog';
import { createSimulatedProviderBundle } from './simulatedBundle';
import { createSimulationAppRuntime } from './appRuntimeFixture';
import { StateReconciler } from './reconciler';
import { runSimulatedAmazonTracking } from './simulatedTracking';
import { atlantaDayAndHour } from '../services/nightlyAmazonTracking';
import { processEmail, WorkflowReviewRequiredError, type ReceivedEmail } from '../services/dealEmailWorkflow';
import type { ProviderBundle } from '../providers/interfaces';
import type { RelationalRuntime } from '../services/relationalRuntime';
import type {
  SimulatedAmazonScenario,
  SimulatedReservation,
  SimulatedTrackingScenario,
  ScriptedFault,
  FaultType,
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
  purchaseStageComplete: boolean;
}

function purchaseScenarioForRun(base: ScenarioDefinition, overrides: {
  amazon?: unknown;
  purchaseStart?: unknown;
  trackingStart?: unknown;
  tracking?: unknown;
  faults?: unknown;
}): ScenarioDefinition {
  const scenario = structuredClone(base);
  if (scenario.phase !== 2 && scenario.phase !== 3) {
    if (overrides.amazon !== undefined || overrides.purchaseStart !== undefined || overrides.trackingStart !== undefined ||
        overrides.tracking !== undefined || overrides.faults !== undefined) {
      throw new Error('Purchase/tracking inputs can only be edited for Phase 2 or Phase 3 scenarios.');
    }
    return scenario;
  }
  if (!scenario.amazon) throw new Error('Phase 2 scenario is missing its Amazon input profile.');
  if (overrides.purchaseStart !== undefined) {
    if (scenario.phase !== 2) throw new Error('Purchase start mode is configured through Phase 3 tracking start.');
    if (overrides.purchaseStart !== 'END_TO_END' && overrides.purchaseStart !== 'SEEDED_RESERVATION') {
      throw new Error('Purchase start must be END_TO_END or SEEDED_RESERVATION.');
    }
    scenario.purchaseStart = overrides.purchaseStart;
  }
  if (overrides.trackingStart !== undefined) {
    if (scenario.phase !== 3 || !['PHASE2_PURCHASE','SEEDED_ORDER'].includes(String(overrides.trackingStart))) {
      throw new Error('Tracking start must be PHASE2_PURCHASE or SEEDED_ORDER in Phase 3.');
    }
    scenario.trackingStart = overrides.trackingStart as 'PHASE2_PURCHASE' | 'SEEDED_ORDER';
  }
  if (overrides.amazon !== undefined) {
    if (!overrides.amazon || typeof overrides.amazon !== 'object' || Array.isArray(overrides.amazon)) {
      throw new Error('Amazon scenario inputs must be an object.');
    }
    const value = overrides.amazon as Record<string, unknown>;
    const fields = ['accountEmail','accountState','asin','available','quantity','itemSubtotalCents','shippingCents',
      'taxCents','discountCents','isGift','isFreeNonPrimeDelivery','addressMatches','paymentCardMatches','cartState',
      'deliveryEstimate','existingUnpaidPayoutCents','orderVisibilityDelaySeconds'];
    if (Object.keys(value).some(key => !fields.includes(key))) throw new Error('Unknown Amazon scenario input.');
    const merged = { ...scenario.amazon, ...value } as SimulatedAmazonScenario;
    if (!/^[^\s@]+@example\.invalid$/i.test(merged.accountEmail) ||
        !['AUTHENTICATED','AUTH_REQUIRED','CHALLENGE'].includes(merged.accountState) ||
        !/^[A-Z0-9]{10}$/.test(merged.asin) || typeof merged.available !== 'boolean' ||
        !Number.isSafeInteger(merged.quantity) || merged.quantity < 1 || merged.quantity > 10 ||
        ![merged.itemSubtotalCents, merged.shippingCents, merged.taxCents, merged.discountCents,
          merged.existingUnpaidPayoutCents].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 999999999999) ||
        ![merged.isGift, merged.isFreeNonPrimeDelivery, merged.addressMatches, merged.paymentCardMatches].every(v => typeof v === 'boolean') ||
        !['EMPTY','EXPECTED_ITEM','OTHER_ITEMS','UNKNOWN'].includes(merged.cartState) ||
        !merged.deliveryEstimate || !['KNOWN','ABSENT','UNKNOWN'].includes(merged.deliveryEstimate.type) ||
        typeof merged.deliveryEstimate.rawText !== 'string' ||
        (merged.deliveryEstimate.latestDate !== undefined && !Number.isFinite(Date.parse(merged.deliveryEstimate.latestDate))) ||
        (merged.orderVisibilityDelaySeconds !== undefined && (!Number.isSafeInteger(merged.orderVisibilityDelaySeconds) ||
          merged.orderVisibilityDelaySeconds < 0 || merged.orderVisibilityDelaySeconds > 86400))) {
      throw new Error('Amazon scenario inputs failed validation.');
    }
    scenario.amazon = merged;
    scenario.initialDeals = scenario.initialDeals.map(deal => ({
      ...deal, asin: merged.asin, retailCents: merged.itemSubtotalCents,
    }));
  }
  if (overrides.tracking !== undefined) {
    if (scenario.phase !== 3 || !overrides.tracking || typeof overrides.tracking !== 'object' || Array.isArray(overrides.tracking)) {
      throw new Error('Tracking scenario inputs are editable only in Phase 3.');
    }
    const value = overrides.tracking as Record<string, unknown>;
    const fields = ['initialStatus','trackingNumber','carrier','visibilityDelaySeconds','purchaseAgeHours',
      'orderIdMatches','asinMatches','totalMatches'];
    if (Object.keys(value).some(key => !fields.includes(key))) throw new Error('Unknown tracking scenario input.');
    const merged = { ...scenario.tracking, ...value } as SimulatedTrackingScenario;
    if (!['PENDING','SHIPPED','DELIVERED','INCOMPLETE','MISMATCHED','MULTIPLE'].includes(merged.initialStatus) ||
        typeof merged.trackingNumber !== 'string' || merged.trackingNumber.length > 40 ||
        (merged.trackingNumber !== '' && !/^[A-Z0-9-]{8,40}$/i.test(merged.trackingNumber)) ||
        typeof merged.carrier !== 'string' || merged.carrier.length > 80 ||
        !Number.isSafeInteger(merged.visibilityDelaySeconds) || merged.visibilityDelaySeconds < 0 || merged.visibilityDelaySeconds > 604800 ||
        !Number.isSafeInteger(merged.purchaseAgeHours) || merged.purchaseAgeHours < 1 || merged.purchaseAgeHours > 8760 ||
        ![merged.orderIdMatches,merged.asinMatches,merged.totalMatches].every(item => typeof item === 'boolean')) {
      throw new Error('Tracking scenario inputs failed validation.');
    }
    scenario.tracking = merged;
  }
  if (overrides.faults !== undefined) {
    if (!Array.isArray(overrides.faults) || overrides.faults.length > 12) {
      throw new Error('Fault scenarios must be a list with at most 12 entries.');
    }
    const targetOps: ScriptedFault['targetOp'][] = [
      'VERIFY_SESSION','SUBMIT_RESERVATION','RESOLVE_DEAL','TRACKER_READ','CANCEL_RESERVATION',
      'AMAZON_ACCOUNT','AMAZON_SUPPLIER_READ','AMAZON_CART_READ','AMAZON_CHECKOUT_PREPARE',
      'AMAZON_ORDER_SUBMIT','AMAZON_ORDER_READ','APPLICATION_ORDER_PERSIST',
      'AMAZON_TRACKING_READ','BFMR_PURCHASE_SUBMIT','BFMR_SHIPMENT_SUBMIT',
      'BFMR_TRACKER_READ',
    ];
    const faultTypes: FaultType[] = [
      'FAIL_BEFORE_COMMIT','DROP_CONFIRMATION_AFTER_COMMIT','DELAY_VISIBILITY','INCOMPLETE_READ',
      'AUTH_CHALLENGE','CART_STATE_UNKNOWN','DUPLICATE_SUBMISSION','APPLICATION_PERSISTENCE_FAILURE',
    ];
    const allowed: Partial<Record<ScriptedFault['targetOp'], FaultType[]>> = {
      VERIFY_SESSION: ['FAIL_BEFORE_COMMIT'], SUBMIT_RESERVATION: ['FAIL_BEFORE_COMMIT','DROP_CONFIRMATION_AFTER_COMMIT'],
      RESOLVE_DEAL: ['FAIL_BEFORE_COMMIT'], TRACKER_READ: ['FAIL_BEFORE_COMMIT','INCOMPLETE_READ'],
      CANCEL_RESERVATION: ['FAIL_BEFORE_COMMIT'], AMAZON_ACCOUNT: ['AUTH_CHALLENGE'],
      AMAZON_SUPPLIER_READ: ['FAIL_BEFORE_COMMIT','INCOMPLETE_READ'], AMAZON_CART_READ: ['CART_STATE_UNKNOWN'],
      AMAZON_CHECKOUT_PREPARE: ['FAIL_BEFORE_COMMIT'],
      AMAZON_ORDER_SUBMIT: ['FAIL_BEFORE_COMMIT','DROP_CONFIRMATION_AFTER_COMMIT','DELAY_VISIBILITY','DUPLICATE_SUBMISSION'],
      AMAZON_ORDER_READ: ['DELAY_VISIBILITY','INCOMPLETE_READ','FAIL_BEFORE_COMMIT'],
      APPLICATION_ORDER_PERSIST: ['APPLICATION_PERSISTENCE_FAILURE'],
      AMAZON_TRACKING_READ: ['FAIL_BEFORE_COMMIT','INCOMPLETE_READ','DELAY_VISIBILITY'],
      BFMR_PURCHASE_SUBMIT: ['FAIL_BEFORE_COMMIT','DROP_CONFIRMATION_AFTER_COMMIT','DELAY_VISIBILITY'],
      BFMR_SHIPMENT_SUBMIT: ['FAIL_BEFORE_COMMIT','DROP_CONFIRMATION_AFTER_COMMIT','DELAY_VISIBILITY'],
      BFMR_TRACKER_READ: ['FAIL_BEFORE_COMMIT','INCOMPLETE_READ','DELAY_VISIBILITY'],
    };
    const seenIds = new Set<string>();
    scenario.faults = overrides.faults.map((raw: unknown) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Each fault must be an object.');
      const fault = raw as Record<string, unknown>;
      const { id, targetOp, faultType, triggerOnAttempt, errorDetail } = fault;
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id) || seenIds.has(id) ||
          typeof targetOp !== 'string' || !targetOps.includes(targetOp as ScriptedFault['targetOp']) ||
          typeof faultType !== 'string' || !faultTypes.includes(faultType as FaultType) ||
          !allowed[targetOp as ScriptedFault['targetOp']]?.includes(faultType as FaultType) ||
          !Number.isSafeInteger(triggerOnAttempt) || (triggerOnAttempt as number) < 1 || (triggerOnAttempt as number) > 100 ||
          (errorDetail !== undefined && (typeof errorDetail !== 'string' || errorDetail.length > 300)) ||
          Object.keys(fault).some(key => !['id','targetOp','faultType','triggerOnAttempt','errorDetail'].includes(key))) {
        throw new Error('Fault scenario failed validation for its target, type, attempt, or detail.');
      }
      seenIds.add(id);
      return { id, targetOp: targetOp as ScriptedFault['targetOp'], faultType: faultType as FaultType,
        triggerOnAttempt: triggerOnAttempt as number, ...(errorDetail ? { errorDetail: errorDetail as string } : {}) };
    });
  }
  return scenario;
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

  public async createRun(scenarioId: string, overrides: { amazon?: unknown; purchaseStart?: unknown; trackingStart?: unknown; tracking?: unknown; faults?: unknown } = {}): Promise<SimulationRunRecord> {
    await this.init();
    const definition = this.getScenario(scenarioId);
    if (!definition) throw new Error(`Scenario not found: ${scenarioId}`);

    const runId = `RUN-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000)}`;
    const scenario = purchaseScenarioForRun(definition, overrides);
    let seededReservation: SimulatedReservation | undefined;
    const initialReservations: SimulatedReservation[] = [];
    const phase2Purchase = scenario.phase === 2 || (scenario.phase === 3 && scenario.trackingStart === 'PHASE2_PURCHASE');
    const existingExposure = scenario.amazon?.existingUnpaidPayoutCents ?? 0;
    if (phase2Purchase && existingExposure > 0) {
      const exposureDealId = `${scenario.initialDeals[0].dealId}-EXPOSURE`;
      scenario.initialDeals.push({
        dealId: exposureDealId, slug: `synthetic-existing-exposure-${runId.toLowerCase()}`,
        title: 'Synthetic Prior Reservation for Exposure',
        dealUrl: `https://bfmr.com/deals/synthetic-existing-exposure-${runId.toLowerCase()}`,
        retailer: 'Amazon', isClosed: false, availableSlots: 0, payoutCents: existingExposure,
        retailCents: 0, asin: scenario.amazon?.asin,
      });
      initialReservations.push({
        reserveId: `SIM-EXPOSURE-${runId}`, dealId: exposureDealId,
        accountId: 'synthetic-operator-1', quantity: 1, status: 'reserved', createdAt: new Date().toISOString(),
      });
    }
    if ((scenario.phase === 2 && scenario.purchaseStart === 'SEEDED_RESERVATION') ||
        (scenario.phase === 3 && scenario.trackingStart === 'PHASE2_PURCHASE')) {
      const deal = scenario.initialDeals.find(item => item.dealId === definition.initialDeals[0]?.dealId);
      if (!deal || !scenario.amazon) throw new Error('Seeded purchase scenarios require one exact deal and Amazon profile.');
      seededReservation = {
        reserveId: `SIM-SEED-${runId}`, dealId: deal.dealId, accountId: 'synthetic-operator-1', quantity: 1,
        status: 'reserved', createdAt: new Date().toISOString(),
      };
      initialReservations.push(seededReservation);
    }
    if (scenario.phase === 3 && scenario.trackingStart === 'SEEDED_ORDER') {
      const deal = scenario.initialDeals.find(item => item.dealId === definition.initialDeals[0]?.dealId);
      if (!deal || !scenario.amazon || !scenario.tracking) {
        throw new Error('Seeded tracking scenarios require one exact deal, Amazon profile, and tracking profile.');
      }
      seededReservation = {
        reserveId: `SIM-TRACK-SEED-${runId}`, dealId: deal.dealId, accountId: 'synthetic-operator-1', quantity: 1,
        status: 'reserved', createdAt: new Date().toISOString(),
      };
      initialReservations.push(seededReservation);
    }
    if (initialReservations.length) scenario.initialReservations = initialReservations;

    const runRecord = await this.store.createRun(scenario, runId);
    const bundle = createSimulatedProviderBundle(this.store, runId, {
      accountId: 'synthetic-operator-1',
      initialTime: new Date(runRecord.virtualTime),
      phase: phase2Purchase ? 2 : scenario.phase,
      purchaseStart: phase2Purchase ? 'SEEDED_RESERVATION' : scenario.purchaseStart,
      trackingStart: scenario.trackingStart,
      seededReservation,
    });

    const appRuntime = await createSimulationAppRuntime({
      account: 'synthetic-operator-1',
      retailerEmail: scenario.amazon?.accountEmail ?? 'buyer@example.invalid',
    });

    if (scenario.initialReservations?.length) {
      const seedRows = await bundle.bfmrApi.readRecentReservedRows();
      const result = await appRuntime.sync.reconcile(seedRows, {
        complete: true, accountValidated: true, financialContractValidated: true,
      });
      if (!result.promoted) throw new Error('Seeded provider reservation could not be established in application state.');
    }

    if (scenario.phase === 3 && scenario.trackingStart === 'SEEDED_ORDER') {
      if (!seededReservation || !scenario.amazon || !scenario.tracking) throw new Error('Seeded tracking scenario is incomplete.');
      const purchasedAt = new Date(Date.parse(runRecord.virtualTime) - scenario.tracking.purchaseAgeHours * 60 * 60 * 1000).toISOString();
      const seededOrder = await this.store.seedAmazonTrackingOrder(runId, {
        reserveId: seededReservation.reserveId, dealId: seededReservation.dealId,
        asin: scenario.amazon.asin, totalCents: scenario.amazon.itemSubtotalCents + scenario.amazon.taxCents +
          scenario.amazon.shippingCents - scenario.amazon.discountCents, purchasedAt,
      });
      await appRuntime.ledger.add({ orderId: seededOrder.orderId, reserveId: seededReservation.reserveId,
        dealId: seededReservation.dealId, asin: seededOrder.asin, totalCents: seededOrder.totalCents,
        purchasedAt, status: 'PENDING', packages: [] });
      await this.store.updateRunStatus(runId, 'STEPPING');
    }

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
      purchaseStageComplete: scenario.phase === 3 && scenario.trackingStart === 'SEEDED_ORDER',
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
    if (ctx.scenario.phase === 3 && ctx.scenario.trackingStart === 'SEEDED_ORDER') {
      const diff = await this.reconciler.evaluateDiff(runId, ctx.appRuntime.db);
      return { run: existingRun, diff };
    }
    if (ctx.scenario.phase === 3 && ctx.purchaseStageComplete) {
      const diff = await this.reconciler.evaluateDiff(runId, ctx.appRuntime.db);
      return { run: existingRun, diff };
    }
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

      if (ctx.scenario.phase === 3 && ctx.scenario.trackingStart === 'PHASE2_PURCHASE') {
        ctx.purchaseStageComplete = true;
        if (ctx.bundle.simulationScenario) ctx.bundle.simulationScenario.phase = 3;
        await this.store.updateRunStatus(runId, 'STEPPING');
        await this.store.logEvent(runId, 'INFO', 'WORKFLOW', 'Phase 2 purchase is ready; advance virtual time to a due tracking window and run the Phase 3 tracking pass.');
      } else {
        await this.store.updateRunStatus(runId, 'COMPLETED');
        await this.store.logEvent(runId, 'INFO', 'WORKFLOW', `Workflow completed successfully.`);
      }
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

  public async advanceToNextTrackingWindow(runId: string): Promise<string> {
    const run = await this.store.getRun(runId);
    const start = new Date(run.virtualTime);
    const startAtlanta = atlantaDayAndHour(start);
    for (let minute = 1; minute <= 2880; minute++) {
      const candidate = new Date(start.getTime() + minute * 60_000);
      const local = atlantaDayAndHour(candidate);
      const nextWindow = startAtlanta.hour < 3
        ? local.day === startAtlanta.day && local.hour >= 3
        : local.day !== startAtlanta.day && local.hour >= 3;
      if (nextWindow) return this.store.advanceTime(runId, minute * 60);
    }
    throw new Error('Unable to resolve the next 03:00 America/New_York tracking window.');
  }

  public async runTrackingPass(runId: string): Promise<{
    run: SimulationRunRecord; diff: StateComparisonDiff; tracking?: { checked: number; skipped: number; reviews: string[] }; error?: string;
  }> {
    const ctx = this.activeRuns.get(runId);
    if (!ctx || ctx.scenario.phase !== 3) throw new Error('Tracking passes are available only for an active Phase 3 run.');
    if (!ctx.purchaseStageComplete) throw new Error('Run the Phase 2 purchase step before tracking this order.');
    try {
      const tracking = await runSimulatedAmazonTracking(ctx.appRuntime, ctx.bundle, this.store);
      await this.store.updateRunStatus(runId, 'STEPPING');
      const run = await this.store.getRun(runId);
      const diff = await this.reconciler.evaluateDiff(runId, ctx.appRuntime.db);
      return { run, diff, tracking };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.store.logEvent(runId, 'ERROR', 'WORKFLOW', 'Simulated tracking pass failed.', { error: detail.slice(0, 160) });
      const run = await this.store.getRun(runId);
      const diff = await this.reconciler.evaluateDiff(runId, ctx.appRuntime.db);
      return { run, diff, error: detail };
    }
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
