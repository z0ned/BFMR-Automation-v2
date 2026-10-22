import type { QueryResult, QueryResultRow } from 'pg';
import type {
  BusinessQueryable, DbId, DealInput, DealRecord, EmailInput, EmailRecord, JsonObject, JsonValue,
  ObservationInput, ObservationRecord, OrderInput, OrderRecord, ReimbursementInput, ReimbursementRecord,
  ReservationInput, ReservationRecord, ShipmentInput, ShipmentRecord, SyncFinishInput, SyncRunInput,
  SyncRunRecord, WorkflowInput, WorkflowRecord,
} from './relationalTypes';

const MAX_CENTS = 999_999_999_999;
export class BusinessConflictError extends Error {
  readonly code = 'BUSINESS_CONFLICT';
  constructor(message: string) { super(message); this.name = 'BusinessConflictError'; }
}
/** The numeric(12,2) boundary is exact; never pass JS floating-point dollars to SQL. */
export function centsToNumeric(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > MAX_CENTS) throw new Error('Invalid USD cents amount.');
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
export function numericToCents(amount: string): number {
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(amount)) throw new Error('Invalid PostgreSQL USD amount.');
  const [whole, fraction = ''] = amount.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  centsToNumeric(cents);
  return cents;
}
function id(value: string): DbId {
  if (!/^[1-9]\d*$/.test(value) || BigInt(value) > 9223372036854775807n) throw new Error('Invalid internal database identifier.');
  return value;
}
function optionalId(value: string | null | undefined): DbId | null { return value == null ? null : id(value); }
function text(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('Required text value is invalid.');
  return value;
}
function integer(value: number, zero = false): number {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > 2147483647) throw new Error('Invalid integer quantity/count.');
  return value;
}
function instant(value: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error('Timestamp must include a UTC offset.');
  }
  return new Date(value).toISOString();
}
function date(value: string): string {
  if (!/^\d{4}-\d\d-\d\d$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new Error('Invalid calendar date.');
  }
  return value;
}
const forbiddenEvidenceKey = /(?:password|secret|api.?key|authorization|oauth|refresh.?token|access.?token|cvv|ccv|card.?number|cookie|raw.?email|raw.?html|^headers$|^body$|^html$)/i;
/** Structural privacy check complements caller allowlists; it does not infer semantic provenance. */
export function validateSanitizedJson(value: JsonValue): void {
  const visit = (item: JsonValue, depth: number): void => {
    if (depth > 12) throw new Error('Evidence nesting exceeds the supported limit.');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number') { if (!Number.isFinite(item)) throw new Error('Evidence has a nonfinite number.'); return; }
    if (Array.isArray(item)) { item.forEach(child => visit(child, depth + 1)); return; }
    if (typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype) throw new Error('Evidence must contain JSON values only.');
    for (const [key, child] of Object.entries(item)) {
      if (forbiddenEvidenceKey.test(key)) throw new Error('Evidence contains a prohibited sensitive field.');
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 65536) throw new Error('Evidence payload exceeds the supported limit.');
}
function json(value: JsonValue): string { validateSanitizedJson(value); return JSON.stringify(value); }
function normalize<T>(row: T): T {
  const result = { ...row } as Record<string, unknown>;
  for (const [key, value] of Object.entries(result)) if (value instanceof Date) result[key] = value.toISOString();
  return result as T;
}
const orderColumns = `id, order_id, reservation_id, deal_id, retailer_id, retailer_account_id, status_id,
  quantity, canceled_quantity, total_cost, purchase_date::text, product_identifier,
  order_time_estimated_delivery_date::text`;

/** All repositories in a session share the caller's transaction/client. No method retries. */
export class BusinessRepositories implements BusinessQueryable {
  constructor(private readonly connection: BusinessQueryable) {}
  async query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
    const result = await this.connection.query<T>(sql, values);
    return { ...result, rows: result.rows.map(row => normalize(row)) };
  }
  private async one<T extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<T | null> {
    const result = await this.query<T>(sql, values);
    if (result.rows.length > 1) throw new BusinessConflictError('Provider identity is ambiguous in the relational store.');
    return result.rows[0] ?? null;
  }

  readonly emails = {
    upsert: async (input: EmailInput): Promise<EmailRecord> => {
      const gmailId = text(input.gmailMessageId), receivedAt = instant(input.receivedAt);
      const inserted = await this.one<EmailRecord>(`INSERT INTO public.emails(gmail_message_id,subject,email_type,received_at)
        VALUES($1,$2,$3,$4::timestamptz) ON CONFLICT (gmail_message_id) DO NOTHING RETURNING *`,
      [gmailId, input.subject, text(input.emailType), receivedAt]);
      if (inserted) return inserted;
      const existing = await this.emails.findByGmailId(gmailId);
      if (!existing || existing.subject !== input.subject || existing.email_type !== input.emailType || instant(existing.received_at) !== receivedAt) {
        throw new BusinessConflictError('Stored Gmail identity conflicts with the supplied email evidence.');
      }
      return existing;
    },
    findByGmailId: async (gmailId: string): Promise<EmailRecord | null> => this.one<EmailRecord>(
      'SELECT * FROM public.emails WHERE gmail_message_id=$1', [text(gmailId)]),
    linkDeal: async (emailId: DbId, dealId: DbId, referenceType: string | null = null): Promise<void> => {
      await this.query(`INSERT INTO public.email_deals(email_id,deal_id,reference_type) VALUES($1,$2,$3)
        ON CONFLICT (email_id,deal_id) DO NOTHING`, [id(emailId), id(dealId), referenceType]);
      const existing = await this.one<{ reference_type: string | null }>(
        'SELECT reference_type FROM public.email_deals WHERE email_id=$1 AND deal_id=$2', [emailId, dealId]);
      if (!existing || existing.reference_type !== referenceType) throw new BusinessConflictError('Email/deal reference classification changed.');
    },
  };

  readonly deals = {
    upsert: async (input: DealInput): Promise<DealRecord> => {
      const row = await this.one<DealRecord>(`INSERT INTO public.deals(bfmr_deal_id,slug,title,reimbursement_amount,description)
        VALUES($1,$2,$3,$4::numeric,$5) ON CONFLICT (bfmr_deal_id) DO UPDATE SET
        slug=EXCLUDED.slug,title=EXCLUDED.title,reimbursement_amount=EXCLUDED.reimbursement_amount,
        description=CASE WHEN $6::boolean THEN EXCLUDED.description ELSE deals.description END RETURNING *`,
      [text(input.bfmrDealId), text(input.slug), text(input.title), centsToNumeric(input.reimbursementAmountCents), input.description ?? null, input.description !== undefined]);
      return row!;
    },
    findByBfmrId: async (bfmrId: string): Promise<DealRecord | null> => this.one<DealRecord>(
      'SELECT * FROM public.deals WHERE bfmr_deal_id=$1', [text(bfmrId)]),
    findById: async (dealId: DbId): Promise<DealRecord | null> => this.one<DealRecord>(
      'SELECT * FROM public.deals WHERE id=$1', [id(dealId)]),
    ensureRetailer: async (dealId: DbId, retailerId: DbId): Promise<void> => {
      await this.query('INSERT INTO public.deal_retailers(deal_id,retailer_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [id(dealId), id(retailerId)]);
    },
  };

  readonly reservations = {
    create: async (input: ReservationInput): Promise<ReservationRecord> => {
      const quantity = integer(input.quantity), rate = centsToNumeric(input.payoutPerItemCents);
      centsToNumeric(quantity * input.payoutPerItemCents);
      const source = optionalId(input.sourceEmailId);
      const inserted = await this.one<ReservationRecord>(`INSERT INTO public.reservations
        (bfmr_reservation_id,deal_id,source_email_id,quantity,payout_per_item,reservation_status_id)
        VALUES($1,$2,$3,$4,$5::numeric,$6) ON CONFLICT (bfmr_reservation_id) DO NOTHING RETURNING *`,
      [text(input.bfmrReservationId), id(input.dealId), source, quantity, rate, id(input.reservationStatusId ?? '1')]);
      if (inserted) return inserted;
      const existing = await this.one<ReservationRecord>('SELECT * FROM public.reservations WHERE bfmr_reservation_id=$1 FOR UPDATE', [input.bfmrReservationId]);
      if (!existing || existing.deal_id !== input.dealId || existing.source_email_id !== source || existing.quantity !== quantity ||
          numericToCents(existing.payout_per_item) !== input.payoutPerItemCents || numericToCents(existing.expected_payout) !== quantity * input.payoutPerItemCents) {
        throw new BusinessConflictError('Reservation creation identity or financial terms conflict; retain provider evidence for review.');
      }
      return existing;
    },
    findByBfmrId: async (bfmrId: string): Promise<ReservationRecord | null> => this.one<ReservationRecord>(
      'SELECT * FROM public.reservations WHERE bfmr_reservation_id=$1', [text(bfmrId)]),
    findById: async (reservationId: DbId): Promise<ReservationRecord | null> => this.one<ReservationRecord>(
      'SELECT * FROM public.reservations WHERE id=$1', [id(reservationId)]),
    list: async (): Promise<ReservationRecord[]> => (await this.query<ReservationRecord>('SELECT * FROM public.reservations ORDER BY id')).rows,
    updateStatus: async (reservationId: DbId, statusId: DbId): Promise<ReservationRecord> => {
      const row = await this.one<ReservationRecord>('UPDATE public.reservations SET reservation_status_id=$2 WHERE id=$1 RETURNING *', [id(reservationId), id(statusId)]);
      if (!row) throw new BusinessConflictError('Cannot update a missing reservation.');
      return row;
    },
    updatePayout: async (reservationId: DbId, payoutPerItemCents: number): Promise<ReservationRecord> => {
      const row = await this.one<ReservationRecord>(
        'UPDATE public.reservations SET payout_per_item=$2::numeric WHERE id=$1 RETURNING *',
        [id(reservationId), centsToNumeric(payoutPerItemCents)]
      );
      if (!row) throw new BusinessConflictError('Cannot update payout of a missing reservation.');
      return row;
    },
  };

  readonly orders = {
    create: async (input: OrderInput): Promise<OrderRecord> => {
      integer(input.quantity); const canceled = integer(input.canceledQuantity ?? 0, true);
      if (canceled > input.quantity) throw new Error('Canceled quantity exceeds ordered quantity.');
      const reservation = await this.reservations.findById(input.reservationId);
      if (!reservation || reservation.deal_id !== input.dealId || input.quantity > reservation.quantity) {
        throw new BusinessConflictError('Order reservation/deal/quantity does not match its locked reservation.');
      }
      const inserted = await this.one<OrderRecord>(`INSERT INTO public.orders
        (order_id,reservation_id,deal_id,retailer_id,retailer_account_id,status_id,quantity,canceled_quantity,total_cost,purchase_date,product_identifier,order_time_estimated_delivery_date)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::numeric,$10::date,$11,$12::date) ON CONFLICT DO NOTHING RETURNING ${orderColumns}`,
      [text(input.orderId), id(input.reservationId), id(input.dealId), id(input.retailerId), id(input.retailerAccountId), id(input.statusId ?? '1'),
        input.quantity, canceled, centsToNumeric(input.totalCostCents), date(input.purchaseDate), text(input.productIdentifier),
        input.orderTimeEstimatedDeliveryDate == null ? null : date(input.orderTimeEstimatedDeliveryDate)]);
      if (inserted) return inserted;
      const existing = await this.orders.findByReservationId(input.reservationId);
      if (!existing || existing.order_id !== input.orderId || existing.deal_id !== input.dealId || existing.retailer_id !== input.retailerId ||
          existing.retailer_account_id !== input.retailerAccountId || existing.quantity !== input.quantity ||
          numericToCents(existing.total_cost) !== input.totalCostCents || existing.purchase_date !== input.purchaseDate ||
          existing.product_identifier !== input.productIdentifier || existing.order_time_estimated_delivery_date !== (input.orderTimeEstimatedDeliveryDate ?? null)) {
        throw new BusinessConflictError('Order identity or purchase terms conflict with an existing order.');
      }
      return existing;
    },
    findById: async (orderId: DbId): Promise<OrderRecord | null> => this.one<OrderRecord>(`SELECT ${orderColumns} FROM public.orders WHERE id=$1`, [id(orderId)]),
    findByExternalId: async (externalOrderId: string, retailerId?: DbId): Promise<OrderRecord | null> => this.one<OrderRecord>(
      `SELECT ${orderColumns} FROM public.orders WHERE order_id=$1 AND ($2::bigint IS NULL OR retailer_id=$2)`, [text(externalOrderId), optionalId(retailerId)]),
    findByReservationId: async (reservationId: DbId): Promise<OrderRecord | null> => this.one<OrderRecord>(
      `SELECT ${orderColumns} FROM public.orders WHERE reservation_id=$1`, [id(reservationId)]),
    list: async (): Promise<OrderRecord[]> => (await this.query<OrderRecord>(`SELECT ${orderColumns} FROM public.orders ORDER BY id`)).rows,
    updateStatus: async (orderId: DbId, statusId: DbId, canceledQuantity?: number): Promise<OrderRecord> => {
      if (canceledQuantity !== undefined) integer(canceledQuantity, true);
      const row = await this.one<OrderRecord>(`UPDATE public.orders SET status_id=$2,
        canceled_quantity=COALESCE($3::integer,canceled_quantity) WHERE id=$1 RETURNING ${orderColumns}`,
      [id(orderId), id(statusId), canceledQuantity ?? null]);
      if (!row) throw new BusinessConflictError('Cannot update a missing order.'); return row;
    },
  };

  readonly shipments = {
    save: async (input: ShipmentInput): Promise<ShipmentRecord> => {
      const order = await this.orders.findById(input.orderId);
      if (!order || integer(input.quantity) > order.quantity - order.canceled_quantity) throw new BusinessConflictError('Shipment quantity exceeds the uncanceled order quantity.');
      const inserted = await this.one<ShipmentRecord>(`INSERT INTO public.shipments(order_id,tracking_number,shipping_company,quantity,status_id)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT (order_id) DO NOTHING RETURNING *`,
      [id(input.orderId), text(input.trackingNumber), text(input.shippingCompany), input.quantity, id(input.statusId ?? '1')]);
      if (inserted) return inserted;
      const existing = await this.shipments.findByOrderId(input.orderId);
      if (!existing || existing.tracking_number !== input.trackingNumber || existing.shipping_company !== input.shippingCompany || existing.quantity !== input.quantity) {
        throw new BusinessConflictError('Multiple or conflicting shipment/tracking identities require review.');
      }
      return (await this.one<ShipmentRecord>('UPDATE public.shipments SET status_id=$2 WHERE id=$1 RETURNING *', [existing.id, id(input.statusId ?? existing.status_id)]))!;
    },
    findByOrderId: async (orderId: DbId): Promise<ShipmentRecord | null> => this.one<ShipmentRecord>('SELECT * FROM public.shipments WHERE order_id=$1', [id(orderId)]),
    findByTrackingNumber: async (trackingNumber: string): Promise<ShipmentRecord | null> =>
      this.one<ShipmentRecord>('SELECT * FROM public.shipments WHERE tracking_number=$1 LIMIT 1', [text(trackingNumber)]),
  };

  readonly reimbursements = {
    create: async (input: ReimbursementInput): Promise<ReimbursementRecord> => {
      const paidAt = instant(input.paidAt), amount = centsToNumeric(input.amountCents), reference = input.paymentReference ?? null;
      const inserted = await this.one<ReimbursementRecord>(`INSERT INTO public.reimbursements(reservation_id,payment_email_id,amount,paid_at,payment_reference)
        VALUES($1,$2,$3::numeric,$4::timestamptz,$5) ON CONFLICT (reservation_id) DO NOTHING RETURNING *`,
      [id(input.reservationId), id(input.paymentEmailId), amount, paidAt, reference]);
      if (inserted) return inserted;
      const existing = await this.reimbursements.findByReservationId(input.reservationId);
      if (!existing || existing.payment_email_id !== input.paymentEmailId || numericToCents(existing.amount) !== input.amountCents || instant(existing.paid_at) !== paidAt || existing.payment_reference !== reference) {
        throw new BusinessConflictError('A different reimbursement already exists for the reservation.');
      }
      return existing;
    },
    findByReservationId: async (reservationId: DbId): Promise<ReimbursementRecord | null> => this.one<ReimbursementRecord>(
      'SELECT * FROM public.reimbursements WHERE reservation_id=$1', [id(reservationId)]),
    list: async (): Promise<ReimbursementRecord[]> => (await this.query<ReimbursementRecord>('SELECT * FROM public.reimbursements ORDER BY id')).rows,
  };

  readonly evidence = {
    appendWorkflow: async (input: WorkflowInput): Promise<WorkflowRecord> => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.correlationId)) throw new Error('Invalid workflow correlation UUID.');
      const facts = input.evidence ?? {};
      if (!facts || Array.isArray(facts) || typeof facts !== 'object') throw new Error('Workflow evidence must be a JSON object.');
      return (await this.one<WorkflowRecord>(`INSERT INTO public.workflow_evidence
        (email_id,reservation_id,order_id,correlation_id,action_type,phase,outcome,evidence,recorded_at)
        VALUES($1,$2,$3,$4::uuid,$5,$6,$7,$8::jsonb,$9::timestamptz) RETURNING *`,
      [optionalId(input.emailId), optionalId(input.reservationId), optionalId(input.orderId), input.correlationId,
        text(input.actionType), text(input.phase), input.outcome == null ? null : text(input.outcome), json(facts), instant(input.recordedAt ?? new Date().toISOString())]))!;
    },
    appendObservation: async (input: ObservationInput): Promise<ObservationRecord> => (await this.one<ObservationRecord>(`INSERT INTO public.provider_observations
      (email_id,deal_id,reservation_id,order_id,shipment_id,reimbursement_id,sync_run_id,provider,resource_type,observed_at,is_complete,response_data)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11,$12::jsonb) RETURNING *`,
    [optionalId(input.emailId), optionalId(input.dealId), optionalId(input.reservationId), optionalId(input.orderId), optionalId(input.shipmentId),
      optionalId(input.reimbursementId), optionalId(input.syncRunId), text(input.provider), text(input.resourceType), instant(input.observedAt), input.isComplete, json(input.responseData)]))!,
    workflowForOrder: async (orderId: DbId, actionType?: string): Promise<WorkflowRecord[]> => (await this.query<WorkflowRecord>(
      `SELECT * FROM public.workflow_evidence WHERE order_id=$1 AND ($2::text IS NULL OR action_type=$2) ORDER BY recorded_at,id`, [id(orderId), actionType ?? null])).rows,
    latestWorkflow: async (actionType: string, orderId?: DbId): Promise<WorkflowRecord | null> => this.one<WorkflowRecord>(
      `SELECT * FROM public.workflow_evidence WHERE action_type=$1 AND ($2::bigint IS NULL OR order_id=$2) ORDER BY recorded_at DESC,id DESC LIMIT 1`,
      [text(actionType), optionalId(orderId)]),
  };

  readonly syncRuns = {
    start: async (input: SyncRunInput): Promise<SyncRunRecord> => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(input.scope)) throw new Error('Invalid synchronization scope.');
      return (await this.one<SyncRunRecord>(`INSERT INTO public.sync_runs(provider,scope,target_order_id,started_at,completed_at,status,records_received,is_complete,error_message)
        VALUES($1,$2,$3,$4::timestamptz,NULL,'RUNNING',0,FALSE,NULL) RETURNING *`,
      [text(input.provider), input.scope, optionalId(input.targetOrderId), instant(input.startedAt ?? new Date().toISOString())]))!;
    },
    finish: async (runId: DbId, input: SyncFinishInput): Promise<SyncRunRecord> => {
      const count = integer(input.recordsReceived, true);
      const row = await this.one<SyncRunRecord>(`UPDATE public.sync_runs SET status=$2,records_received=$3,
        completed_at=$4::timestamptz,is_complete=$5,error_message=$6 WHERE id=$1 AND status='RUNNING' RETURNING *`,
      [id(runId), input.status, count, instant(input.completedAt ?? new Date().toISOString()), input.status === 'COMPLETED', input.errorMessage ?? null]);
      if (!row) throw new BusinessConflictError('Synchronization run is missing or already finalized.'); return row;
    },
    findById: async (runId: DbId): Promise<SyncRunRecord | null> => this.one<SyncRunRecord>('SELECT * FROM public.sync_runs WHERE id=$1', [id(runId)]),
    latestCompleted: async (provider: string, scope: string, targetOrderId?: DbId): Promise<SyncRunRecord | null> => this.one<SyncRunRecord>(
      `SELECT * FROM public.sync_runs WHERE provider=$1 AND scope=$2 AND target_order_id IS NOT DISTINCT FROM $3::bigint
        AND status='COMPLETED' AND is_complete ORDER BY completed_at DESC,id DESC LIMIT 1`, [text(provider), text(scope), optionalId(targetOrderId)]),
  };
}
