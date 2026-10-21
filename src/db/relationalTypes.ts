import type { QueryResult, QueryResultRow } from 'pg';

/** PostgreSQL bigint/numeric values stay strings at the persistence boundary. */
export type DbId = string;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export interface EmailRecord { id: DbId; gmail_message_id: string; subject: string; email_type: string; received_at: string }
export interface DealRecord { id: DbId; bfmr_deal_id: string; slug: string; title: string; reimbursement_amount: string; description: string | null }
export interface ReservationRecord { id: DbId; bfmr_reservation_id: string; deal_id: DbId; reservation_status_id: DbId; source_email_id: DbId | null; quantity: number; payout_per_item: string; expected_payout: string }
export interface OrderRecord { id: DbId; order_id: string; reservation_id: DbId; deal_id: DbId; retailer_id: DbId; retailer_account_id: DbId; status_id: DbId; quantity: number; canceled_quantity: number; total_cost: string; purchase_date: string; product_identifier: string; order_time_estimated_delivery_date: string | null }
export interface ShipmentRecord { id: DbId; order_id: DbId; tracking_number: string; shipping_company: string; status_id: DbId; quantity: number }
export interface ReimbursementRecord { id: DbId; reservation_id: DbId; payment_email_id: DbId; amount: string; paid_at: string; payment_reference: string | null; recorded_at: string }
export interface WorkflowRecord { id: DbId; email_id: DbId | null; reservation_id: DbId | null; order_id: DbId | null; correlation_id: string; action_type: string; phase: string; outcome: string | null; evidence: JsonObject; recorded_at: string }
export interface ObservationRecord { id: DbId; email_id: DbId | null; deal_id: DbId | null; reservation_id: DbId | null; order_id: DbId | null; shipment_id: DbId | null; reimbursement_id: DbId | null; sync_run_id: DbId | null; provider: string; resource_type: string; observed_at: string; is_complete: boolean; response_data: JsonValue }
export interface SyncRunRecord { id: DbId; provider: string; scope: string; target_order_id: DbId | null; started_at: string; completed_at: string | null; status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'INCOMPLETE'; records_received: number; is_complete: boolean; error_message: string | null }
export interface EmailInput { gmailMessageId: string; subject: string; emailType: string; receivedAt: string }
export interface DealInput { bfmrDealId: string; slug: string; title: string; reimbursementAmountCents: number; description?: string | null }
export interface ReservationInput { bfmrReservationId: string; dealId: DbId; sourceEmailId?: DbId | null; quantity: number; payoutPerItemCents: number; reservationStatusId?: DbId }
export interface OrderInput { orderId: string; reservationId: DbId; dealId: DbId; retailerId: DbId; retailerAccountId: DbId; quantity: number; totalCostCents: number; purchaseDate: string; productIdentifier: string; orderTimeEstimatedDeliveryDate?: string | null; statusId?: DbId; canceledQuantity?: number }
export interface ShipmentInput { orderId: DbId; trackingNumber: string; shippingCompany: string; quantity: number; statusId?: DbId }
export interface ReimbursementInput { reservationId: DbId; paymentEmailId: DbId; amountCents: number; paidAt: string; paymentReference?: string | null }
export interface WorkflowInput { emailId?: DbId | null; reservationId?: DbId | null; orderId?: DbId | null; correlationId: string; actionType: string; phase: string; outcome?: string | null; evidence?: JsonObject; recordedAt?: string }
export interface ObservationInput { emailId?: DbId | null; dealId?: DbId | null; reservationId?: DbId | null; orderId?: DbId | null; shipmentId?: DbId | null; reimbursementId?: DbId | null; syncRunId?: DbId | null; provider: string; resourceType: string; observedAt: string; isComplete: boolean; responseData: JsonValue }
export interface SyncRunInput { provider: string; scope: string; targetOrderId?: DbId | null; startedAt?: string }
export interface SyncFinishInput { status: 'COMPLETED' | 'FAILED' | 'INCOMPLETE'; recordsReceived: number; completedAt?: string; errorMessage?: string | null }
export interface BusinessQueryable { query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>> }
