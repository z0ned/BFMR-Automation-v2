import {
  IntakeEmail,
  PipelineStatus,
  ReservationAttempt,
  Incident,
  ReservationRecord,
} from '../types/bfmr';
import { parseIncomingEmail } from './emailParser';
import { myTrackerService } from './myTracker';

export type OrchestratorListener = () => void;

class BfmrOrchestrator {
  // Singleton lock state
  public isWorkerLocked = false;
  public workerOwnerId = 'worker-primary-singleton-node';

  // Gmail cursor state
  public currentHistoryId = 104250;
  public lastSyncTimestamp = new Date().toISOString();
  public isCatchUpActive = false;
  public cursorExpiredFault = false;

  // Pipeline states
  public currentStatus: PipelineStatus = 'IDLE';
  public currentActiveEmail: IntakeEmail | null = null;
  public currentAttempts: ReservationAttempt[] = [];

  // History & Store
  public processedEmails: IntakeEmail[] = [];
  public attemptsAuditLog: ReservationAttempt[] = [];
  public incidents: Incident[] = [];

  // Listeners for UI updates
  private listeners: Set<OrchestratorListener> = new Set();

  constructor() {
    this.seedInitialHistory();
  }

  public subscribe(listener: OrchestratorListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn());
  }

  private seedInitialHistory() {
    // Initial sample emails
    const seed1 = parseIncomingEmail({
      messageId: '<msg-101@buyformeretail.com>',
      sender: 'deals@buyformeretail.com',
      subject: 'New Deal: Apple 11" iPad Pro M4 Chip 256GB Wi-Fi - Space Black',
      body: 'A new deal has been posted on BFMR!\nLink: https://www.buyformeretail.com/deals/ipad-pro-m4-11-256\nPayout: $920.00\nRetail: $999.00\nRetailer: Best Buy',
      historyId: 104245,
    });
    this.processedEmails.push(seed1);

    const seed2 = parseIncomingEmail({
      messageId: '<msg-102@buyformeretail.com>',
      sender: 'deals@buyformeretail.com',
      subject: 'Multiple Deals: Daily Deals Roundup (5 deals available)',
      body: 'Check out today\'s multiple deals at https://www.buyformeretail.com/deals/all',
      historyId: 104248,
    });
    this.processedEmails.push(seed2);

    this.incidents.push({
      id: 'INC-2026-001',
      level: 'INFO',
      title: 'Worker Bootstrap Complete',
      detail: 'Singleton owner initialized. Cursor historyId set to 104250.',
      timestamp: new Date(Date.now() - 3600 * 1000 * 2).toISOString(),
      sentToTelegram: true,
      resolved: true,
    });
  }

  /**
   * Acquire singleton worker lock.
   * "One account worker and browser owner; durable attempt record before a possible click."
   */
  public acquireLock(): boolean {
    if (this.isWorkerLocked) {
      return false;
    }
    this.isWorkerLocked = true;
    this.notify();
    return true;
  }

  public releaseLock(): void {
    this.isWorkerLocked = false;
    this.notify();
  }

  /**
   * Add an incident and send to Telegram outbox
   */
  public reportIncident(
    level: Incident['level'],
    title: string,
    detail: string,
    relatedDealId?: string
  ): Incident {
    const inc: Incident = {
      id: `INC-${Date.now().toString().slice(-6)}`,
      level,
      title,
      detail,
      timestamp: new Date().toISOString(),
      sentToTelegram: true,
      resolved: false,
      relatedDealId,
    };
    this.incidents.unshift(inc);
    this.notify();
    return inc;
  }

  /**
   * Main Pipeline Execution: Processes an email through T1 to T6
   */
  public async processEmailPipeline(rawEmailData: {
    messageId: string;
    sender: string;
    subject: string;
    body: string;
    forceUncertain?: boolean;
    simulatePageError?: boolean;
  }): Promise<{
    status: PipelineStatus;
    message: string;
    attempts: ReservationAttempt[];
    reservation?: ReservationRecord;
  }> {
    // 1. Check singleton worker lock
    if (this.isWorkerLocked) {
      const err = 'Worker is currently locked by another concurrent process. Transaction aborted.';
      this.reportIncident('WARNING', 'Concurrency Lock Rejected', err);
      return { status: 'REVIEW_REQUIRED', message: err, attempts: [] };
    }

    this.acquireLock();
    this.currentAttempts = [];

    try {
      // Check for cursor fault
      if (this.cursorExpiredFault) {
        this.currentStatus = 'REVIEW_REQUIRED';
        const msg = 'Gmail History cursor expired! Catch-up halted per OQ-001 boundary to prevent unauthorized inbox sweep.';
        this.reportIncident('CRITICAL', 'Gmail Cursor Expired Fault', msg);
        this.notify();
        return { status: 'REVIEW_REQUIRED', message: msg, attempts: [] };
      }

      // T1_INTAKE: Ingest and persist before ACK
      this.currentStatus = 'INGESTING';
      const email = parseIncomingEmail({
        messageId: rawEmailData.messageId,
        sender: rawEmailData.sender,
        subject: rawEmailData.subject,
        body: rawEmailData.body,
        historyId: ++this.currentHistoryId,
      });
      this.currentActiveEmail = email;
      this.processedEmails.unshift(email);
      this.notify();

      await new Promise((r) => setTimeout(r, 400));

      // T2_DEDUPE & Validation:
      // Check single new-deal rule
      if (email.isMultiDeal) {
        this.currentStatus = 'SKIPPED_INVALID_FORMAT';
        this.notify();
        return {
          status: 'SKIPPED_INVALID_FORMAT',
          message: 'Ignored: Multiple-deal email per MVP 1 scope boundary.',
          attempts: [],
        };
      }

      if (email.isAdditionalSlotNotice) {
        this.currentStatus = 'SKIPPED_INVALID_FORMAT';
        this.notify();
        return {
          status: 'SKIPPED_INVALID_FORMAT',
          message: 'Ignored: Additional-slot notification per MVP 1 scope boundary.',
          attempts: [],
        };
      }

      if (!email.isSingleDeal || !email.canonicalDealId) {
        this.currentStatus = 'SKIPPED_INVALID_FORMAT';
        this.notify();
        return {
          status: 'SKIPPED_INVALID_FORMAT',
          message: 'Ignored: Not a valid single new-deal email or untrusted domain link.',
          attempts: [],
        };
      }

      // T3_TRACKER_CHECK: Check My Tracker for existing reservation
      this.currentStatus = 'CHECKING_TRACKER';
      this.notify();
      await new Promise((r) => setTimeout(r, 450));

      const trackerCheck = await myTrackerService.checkExistingReservation(email.canonicalDealId);
      if (trackerCheck.hasDuplicate) {
        this.currentStatus = 'SKIPPED_DUPLICATE';
        this.notify();
        return {
          status: 'SKIPPED_DUPLICATE',
          message: `Duplicate detected in My Tracker: ${trackerCheck.reason}`,
          attempts: [],
        };
      }

      // T4 & T5: Attempt 1 Submission
      // Create durable attempt record before click!
      const attempt1: ReservationAttempt = {
        id: `att-${Date.now()}-ord1`,
        emailId: email.id,
        canonicalDealId: email.canonicalDealId,
        ordinal: 1,
        stage: 'T4_DURABLE_RECORD',
        status: 'IN_FLIGHT',
        timestamp: new Date().toISOString(),
      };
      this.currentAttempts.push(attempt1);
      this.attemptsAuditLog.unshift(attempt1);
      this.currentStatus = 'DURABLE_ATTEMPT';
      this.notify();

      await new Promise((r) => setTimeout(r, 400));

      // Now T5: Form submit via Playwright browser
      this.currentStatus = 'SUBMITTING';
      attempt1.stage = 'T5_FORM_SUBMIT';
      this.notify();
      await new Promise((r) => setTimeout(r, 550));

      if (rawEmailData.simulatePageError) {
        attempt1.status = 'FAILED';
        attempt1.errorMessage = 'Playwright navigation error: HTTP 500 Internal Error from BFMR';
        this.notify();

        // Retry policy: max 2 ordinals as per spec
        // Attempt 2
        const attempt2: ReservationAttempt = {
          id: `att-${Date.now()}-ord2`,
          emailId: email.id,
          canonicalDealId: email.canonicalDealId,
          ordinal: 2,
          stage: 'T4_DURABLE_RECORD',
          status: 'IN_FLIGHT',
          timestamp: new Date().toISOString(),
        };
        this.currentAttempts.push(attempt2);
        this.attemptsAuditLog.unshift(attempt2);
        this.notify();
        await new Promise((r) => setTimeout(r, 500));

        attempt2.stage = 'T5_FORM_SUBMIT';
        attempt2.status = 'FAILED';
        attempt2.errorMessage = 'Playwright retry failed: Button disabled / Reservation exhausted';
        this.currentStatus = 'EXHAUSTED';
        this.reportIncident(
          'WARNING',
          'Reservation Exhausted / Failed Twice',
          `Deal '${email.canonicalDealId}' failed both submit ordinals. Halted per max 2 ordinals constraint.`,
          email.canonicalDealId
        );
        this.notify();

        return {
          status: 'EXHAUSTED',
          message: 'Both submission ordinals failed. Review required.',
          attempts: this.currentAttempts,
        };
      }

      if (rawEmailData.forceUncertain) {
        // Uncertain outcome!
        attempt1.status = 'UNCERTAIN';
        attempt1.errorMessage = 'Network timeout waiting for BFMR reservation confirmation dialog.';
        this.currentStatus = 'RECONCILING';
        attempt1.stage = 'T6_RECONCILE';
        this.notify();
        await new Promise((r) => setTimeout(r, 600));

        // Spec rule: "Reconcile uncertain outcomes before retry. If uncertain, halt and require review."
        this.currentStatus = 'REVIEW_REQUIRED';
        this.reportIncident(
          'CRITICAL',
          'Uncertain Form Submission Outcome',
          `Form submit for deal '${email.canonicalDealId}' returned timeout/uncertain. Stopped before retrying to prevent double reservation.`,
          email.canonicalDealId
        );
        this.notify();

        return {
          status: 'REVIEW_REQUIRED',
          message: 'Uncertain reservation outcome! Stopped to prevent double reservations. Operator review required.',
          attempts: this.currentAttempts,
        };
      }

      // Successful submit & T6 Reconcile with My Tracker
      attempt1.status = 'SUCCESS';
      attempt1.stage = 'T6_RECONCILE';
      this.currentStatus = 'RECONCILING';
      this.notify();
      await new Promise((r) => setTimeout(r, 450));

      const reservation = await myTrackerService.recordReservation({
        canonicalDealId: email.canonicalDealId,
        title: email.dealTitle || email.canonicalDealId,
        retailer: email.retailer || 'Unknown',
        colorVariant: 'Standard',
        source: 'AUTOMATION_MVP1',
      });

      attempt1.reconciledWithTracker = true;
      this.currentStatus = 'CONFIRMED';
      this.notify();

      return {
        status: 'CONFIRMED',
        message: `Successfully reserved 1 offer for '${email.canonicalDealId}'. Confirmed in My Tracker (${reservation.rid}).`,
        attempts: this.currentAttempts,
        reservation,
      };
    } finally {
      this.releaseLock();
    }
  }

  public setCursorExpiredFault(fault: boolean) {
    this.cursorExpiredFault = fault;
    this.notify();
  }

  public resetCursor() {
    this.cursorExpiredFault = false;
    this.currentHistoryId = 104250;
    this.lastSyncTimestamp = new Date().toISOString();
    this.notify();
  }

  public clearIncidents() {
    this.incidents = [];
    this.notify();
  }
}

export const orchestrator = new BfmrOrchestrator();
