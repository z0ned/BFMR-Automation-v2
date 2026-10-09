import {
  RunRow,
  InboundEventRow,
  GmailStateRow,
  EmailRow,
  DealObservationRow,
  CommandRow,
  AttemptRow,
  DealBlockRow,
  IncidentRow,
  NotificationOutboxRow,
  RuntimeGateRow,
  WorkflowEventRow,
} from './schema';

export interface DatabaseState {
  runs: Map<string, RunRow>;
  inbound_events: Map<string, InboundEventRow>;
  gmail_state: Map<string, GmailStateRow>;
  emails: Map<string, EmailRow>;
  deal_observations: Map<string, DealObservationRow>;
  commands: Map<string, CommandRow>;
  attempts: Map<string, AttemptRow>;
  deal_blocks: Map<string, DealBlockRow>;
  incidents: Map<string, IncidentRow>;
  notification_outbox: Map<string, NotificationOutboxRow>;
  runtime_gates: Map<string, RuntimeGateRow>;
  workflow_events: Map<string, WorkflowEventRow>;
  advisory_locks: Set<string>;
}

function cloneState(state: DatabaseState): DatabaseState {
  return {
    runs: new Map(Array.from(state.runs.entries()).map(([k, v]) => [k, { ...v }])),
    inbound_events: new Map(Array.from(state.inbound_events.entries()).map(([k, v]) => [k, { ...v }])),
    gmail_state: new Map(Array.from(state.gmail_state.entries()).map(([k, v]) => [k, { ...v }])),
    emails: new Map(Array.from(state.emails.entries()).map(([k, v]) => [k, { ...v }])),
    deal_observations: new Map(Array.from(state.deal_observations.entries()).map(([k, v]) => [k, { ...v }])),
    commands: new Map(Array.from(state.commands.entries()).map(([k, v]) => [k, { ...v }])),
    attempts: new Map(Array.from(state.attempts.entries()).map(([k, v]) => [k, { ...v }])),
    deal_blocks: new Map(Array.from(state.deal_blocks.entries()).map(([k, v]) => [k, { ...v }])),
    incidents: new Map(Array.from(state.incidents.entries()).map(([k, v]) => [k, { ...v }])),
    notification_outbox: new Map(Array.from(state.notification_outbox.entries()).map(([k, v]) => [k, { ...v }])),
    runtime_gates: new Map(Array.from(state.runtime_gates.entries()).map(([k, v]) => [k, { ...v }])),
    workflow_events: new Map(Array.from(state.workflow_events.entries()).map(([k, v]) => [k, { ...v }])),
    advisory_locks: new Set(state.advisory_locks),
  };
}

export class TransactionalDatabase {
  private state: DatabaseState = {
    runs: new Map(),
    inbound_events: new Map(),
    gmail_state: new Map(),
    emails: new Map(),
    deal_observations: new Map(),
    commands: new Map(),
    attempts: new Map(),
    deal_blocks: new Map(),
    incidents: new Map(),
    notification_outbox: new Map(),
    runtime_gates: new Map(),
    workflow_events: new Map(),
    advisory_locks: new Set(),
  };

  private monotonicSequence = 0;

  /**
   * Execute an atomic transaction.
   * If `fn` throws, all mutations are rolled back.
   */
  public async withTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const backup = cloneState(this.state);
    const tx = new TransactionContext(this.state, () => ++this.monotonicSequence);
    try {
      const result = await fn(tx);
      return result;
    } catch (err) {
      // Rollback
      this.state = backup;
      throw err;
    }
  }

  // Direct read-only helpers
  public getRuns() { return Array.from(this.state.runs.values()); }
  public getInboundEvents() { return Array.from(this.state.inbound_events.values()); }
  public getGmailState(mailbox: string) { return this.state.gmail_state.get(mailbox); }
  public getEmails() { return Array.from(this.state.emails.values()); }
  public getCommands() { return Array.from(this.state.commands.values()); }
  public getAttempts() { return Array.from(this.state.attempts.values()); }
  public getDealBlocks() { return Array.from(this.state.deal_blocks.values()); }
  public getIncidents() { return Array.from(this.state.incidents.values()); }
  public getNotificationOutbox() { return Array.from(this.state.notification_outbox.values()); }
  public getRuntimeGates() { return Array.from(this.state.runtime_gates.values()); }
  public getWorkflowEvents() { return Array.from(this.state.workflow_events.values()); }

  // Advisory lock
  public acquireAdvisoryLock(key: string): boolean {
    if (this.state.advisory_locks.has(key)) {
      return false;
    }
    this.state.advisory_locks.add(key);
    return true;
  }

  public releaseAdvisoryLock(key: string): void {
    this.state.advisory_locks.delete(key);
  }

  public isAdvisoryLockHeld(key: string): boolean {
    return this.state.advisory_locks.has(key);
  }

  public reset(): void {
    this.state = {
      runs: new Map(),
      inbound_events: new Map(),
      gmail_state: new Map(),
      emails: new Map(),
      deal_observations: new Map(),
      commands: new Map(),
      attempts: new Map(),
      deal_blocks: new Map(),
      incidents: new Map(),
      notification_outbox: new Map(),
      runtime_gates: new Map(),
      workflow_events: new Map(),
      advisory_locks: new Set(),
    };
    this.monotonicSequence = 0;
  }
}

export class TransactionContext {
  constructor(
    private state: DatabaseState,
    private nextSeq: () => number
  ) {}

  // Runs
  public insertRun(run: RunRow): void {
    if (this.state.runs.has(run.id)) throw new Error(`Run ${run.id} already exists`);
    this.state.runs.set(run.id, { ...run });
  }

  public updateRun(id: string, updates: Partial<RunRow>): void {
    const existing = this.state.runs.get(id);
    if (!existing) throw new Error(`Run ${id} not found`);
    this.state.runs.set(id, { ...existing, ...updates });
  }

  public getRun(id: string): RunRow | undefined {
    return this.state.runs.get(id);
  }

  // Inbound Events
  public insertInboundEvent(event: InboundEventRow): void {
    // Unique check: (subscription, provider_message_id)
    for (const e of this.state.inbound_events.values()) {
      if (e.subscription === event.subscription && e.provider_message_id === event.provider_message_id) {
        throw new Error(`Unique constraint violation: duplicate inbound_event (${event.subscription}, ${event.provider_message_id})`);
      }
    }
    this.state.inbound_events.set(event.id, { ...event });
  }

  public findInboundEvent(subscription: string, provider_message_id: string): InboundEventRow | undefined {
    for (const e of this.state.inbound_events.values()) {
      if (e.subscription === subscription && e.provider_message_id === provider_message_id) {
        return e;
      }
    }
    return undefined;
  }

  // Gmail State
  public upsertGmailState(entry: GmailStateRow): void {
    this.state.gmail_state.set(entry.mailbox, { ...entry });
  }

  public getGmailState(mailbox: string): GmailStateRow | undefined {
    return this.state.gmail_state.get(mailbox);
  }

  // Emails
  public insertEmail(email: EmailRow): void {
    for (const e of this.state.emails.values()) {
      if (e.mailbox === email.mailbox && e.gmail_id === email.gmail_id) {
        throw new Error(`Unique constraint violation: duplicate email (${email.mailbox}, ${email.gmail_id})`);
      }
    }
    this.state.emails.set(email.id, { ...email });
  }

  public getEmail(id: string): EmailRow | undefined {
    return this.state.emails.get(id);
  }

  public findEmailByGmailId(mailbox: string, gmail_id: string): EmailRow | undefined {
    for (const e of this.state.emails.values()) {
      if (e.mailbox === mailbox && e.gmail_id === gmail_id) return e;
    }
    return undefined;
  }

  // Deal observations
  public insertDealObservation(obs: DealObservationRow): void {
    this.state.deal_observations.set(obs.id, { ...obs });
  }

  // Commands
  public insertCommand(cmd: Omit<CommandRow, 'monotonic_sequence'> & { monotonic_sequence?: number }): CommandRow {
    for (const c of this.state.commands.values()) {
      if (c.request_id === cmd.request_id) {
        throw new Error(`Unique constraint violation: duplicate command request_id (${cmd.request_id})`);
      }
    }
    if (cmd.attempt_count < 0 || cmd.attempt_count > 2) {
      throw new Error(`Check constraint violation: attempt_count must be between 0 and 2`);
    }
    const fullCmd: CommandRow = {
      ...cmd,
      monotonic_sequence: cmd.monotonic_sequence ?? this.nextSeq(),
    };
    this.state.commands.set(cmd.id, fullCmd);
    return fullCmd;
  }

  public updateCommand(id: string, updates: Partial<CommandRow>): void {
    const existing = this.state.commands.get(id);
    if (!existing) throw new Error(`Command ${id} not found`);
    if (updates.attempt_count !== undefined && (updates.attempt_count < 0 || updates.attempt_count > 2)) {
      throw new Error(`Check constraint violation: attempt_count must be between 0 and 2`);
    }
    this.state.commands.set(id, { ...existing, ...updates });
  }

  public getCommand(id: string): CommandRow | undefined {
    return this.state.commands.get(id);
  }

  public getQueuedCommands(): CommandRow[] {
    return Array.from(this.state.commands.values())
      .filter((c) => c.state === 'QUEUED')
      .sort((a, b) => a.monotonic_sequence - b.monotonic_sequence);
  }

  // Attempts
  public insertAttempt(att: AttemptRow): void {
    // Unique check (command_id, ordinal)
    for (const a of this.state.attempts.values()) {
      if (a.command_id === att.command_id && a.ordinal === att.ordinal) {
        throw new Error(`Unique constraint violation: duplicate attempt (command ${att.command_id}, ordinal ${att.ordinal})`);
      }
    }
    if (att.ordinal !== 1 && att.ordinal !== 2) {
      throw new Error(`Check constraint violation: attempt ordinal must be 1 or 2`);
    }
    if (att.quantity !== 1) {
      throw new Error(`Check constraint violation: quantity must be 1 strictly`);
    }
    this.state.attempts.set(att.id, { ...att });
  }

  public updateAttempt(id: string, updates: Partial<AttemptRow>): void {
    const existing = this.state.attempts.get(id);
    if (!existing) throw new Error(`Attempt ${id} not found`);
    this.state.attempts.set(id, { ...existing, ...updates });
  }

  public getAttemptsForCommand(command_id: string): AttemptRow[] {
    return Array.from(this.state.attempts.values())
      .filter((a) => a.command_id === command_id)
      .sort((a, b) => a.ordinal - b.ordinal);
  }

  // Deal blocks
  public insertDealBlock(block: DealBlockRow): void {
    for (const b of this.state.deal_blocks.values()) {
      if (
        b.run_id === block.run_id &&
        b.account_id === block.account_id &&
        b.deal_id === block.deal_id &&
        b.type === block.type &&
        b.resolved_at === null
      ) {
        throw new Error(`Unique active deal_block exists for run=${block.run_id}, deal=${block.deal_id}, type=${block.type}`);
      }
    }
    this.state.deal_blocks.set(block.id, { ...block });
  }

  public isDealBlocked(run_id: string, account_id: string, deal_id: string): boolean {
    for (const b of this.state.deal_blocks.values()) {
      if (b.run_id === run_id && b.account_id === account_id && b.deal_id === deal_id && b.resolved_at === null) {
        return true;
      }
    }
    return false;
  }

  public getDealBlocks(): DealBlockRow[] {
    return Array.from(this.state.deal_blocks.values());
  }

  public getDealBlock(run_id: string, account_id: string, deal_id: string): DealBlockRow | undefined {
    for (const b of this.state.deal_blocks.values()) {
      if (b.run_id === run_id && b.account_id === account_id && b.deal_id === deal_id && b.resolved_at === null) {
        return b;
      }
    }
    return undefined;
  }

  public updateDealBlock(id: string, updates: Partial<DealBlockRow>): void {
    const existing = this.state.deal_blocks.get(id);
    if (!existing) throw new Error(`Deal block ${id} not found`);
    this.state.deal_blocks.set(id, { ...existing, ...updates });
  }

  // Incidents
  public insertIncident(inc: IncidentRow): void {
    this.state.incidents.set(inc.id, { ...inc });
  }

  public updateIncident(id: string, updates: Partial<IncidentRow>): void {
    const existing = this.state.incidents.get(id);
    if (!existing) throw new Error(`Incident ${id} not found`);
    this.state.incidents.set(id, { ...existing, ...updates });
  }

  public getIncident(id: string): IncidentRow | undefined {
    return this.state.incidents.get(id);
  }

  // Notification Outbox
  public insertNotificationOutbox(item: NotificationOutboxRow): void {
    for (const o of this.state.notification_outbox.values()) {
      if (o.incident_id === item.incident_id && o.phase === item.phase) {
        throw new Error(`Unique constraint violation: duplicate notification_outbox (${item.incident_id}, ${item.phase})`);
      }
    }
    this.state.notification_outbox.set(item.id, { ...item });
  }

  public updateNotificationOutbox(id: string, updates: Partial<NotificationOutboxRow>): void {
    const existing = this.state.notification_outbox.get(id);
    if (!existing) throw new Error(`Outbox item ${id} not found`);
    this.state.notification_outbox.set(id, { ...existing, ...updates });
  }

  // Runtime Gates
  public setGate(name: string, reason: string): void {
    this.state.runtime_gates.set(name, {
      gate_name: name,
      reason,
      since: new Date().toISOString(),
    });
  }

  public clearGate(name: string): void {
    this.state.runtime_gates.delete(name);
  }

  public isGateActive(name: string): boolean {
    return this.state.runtime_gates.has(name);
  }

  // Workflow Events
  public logWorkflowEvent(event: WorkflowEventRow): void {
    this.state.workflow_events.set(event.id, { ...event });
  }
}

export const db = new TransactionalDatabase();
