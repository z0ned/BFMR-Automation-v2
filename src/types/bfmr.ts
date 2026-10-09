export type PipelineStatus = 
  | 'IDLE'
  | 'INGESTING'
  | 'CHECKING_TRACKER'
  | 'DURABLE_ATTEMPT'
  | 'SUBMITTING'
  | 'RECONCILING'
  | 'CONFIRMED'
  | 'SKIPPED_DUPLICATE'
  | 'SKIPPED_INVALID_FORMAT'
  | 'REVIEW_REQUIRED'
  | 'EXHAUSTED';

export type IntakeEmail = {
  id: string;
  historyId: number;
  messageId: string;
  sender: string;
  receivedAt: string;
  subject: string;
  rawBody: string;
  isSingleDeal: boolean;
  isAdditionalSlotNotice: boolean;
  isMultiDeal: boolean;
  dealUrl?: string;
  canonicalDealId?: string;
  dealTitle?: string;
  retailer?: string;
  isBundle?: boolean;
  payoutPrice?: number;
  retailPrice?: number;
};

export type ReservationRecord = {
  rid: string;
  canonicalDealId: string;
  title: string;
  retailer: string;
  quantity: number;
  status: 'ACTIVE' | 'RELEASED_MANUALLY' | 'PENDING' | 'EXPIRED';
  reservedAt: string;
  createdAtSource: 'AUTOMATION_MVP1' | 'MANUAL_WEB' | 'PREVIOUS_RUN';
  colorVariant?: string;
  trackingNumber?: string;
  notes?: string;
};

export type ReservationAttempt = {
  id: string;
  emailId: string;
  canonicalDealId: string;
  ordinal: number; // 1 or 2 (max 2 as per spec)
  stage: 'T1_INTAKE' | 'T2_DEDUPE' | 'T3_TRACKER_CHECK' | 'T4_DURABLE_RECORD' | 'T5_FORM_SUBMIT' | 'T6_RECONCILE';
  status: 'SUCCESS' | 'UNCERTAIN' | 'FAILED' | 'IN_FLIGHT';
  errorMessage?: string;
  timestamp: string;
  httpStatus?: number;
  formSelectorHit?: boolean;
  reconciledWithTracker?: boolean;
};

export type Incident = {
  id: string;
  level: 'CRITICAL' | 'WARNING' | 'INFO';
  title: string;
  detail: string;
  timestamp: string;
  sentToTelegram: boolean;
  resolved: boolean;
  relatedDealId?: string;
};

export type AcceptanceTestResult = {
  id: string; // e.g. AT-01, AT-02
  title: string;
  category: 'INTAKE' | 'TRACKER' | 'ORCHESTRATION' | 'BROWSER' | 'OPERATIONS';
  description: string;
  status: 'PASSED' | 'FAILED' | 'PENDING' | 'RUNNING';
  evidenceLogs: string[];
  lastRun?: string;
  milestone: 'M0' | 'M1' | 'M2' | 'M3' | 'M4' | 'M5';
};

export type Milestone = {
  id: 'M0' | 'M1' | 'M2' | 'M3' | 'M4' | 'M5';
  title: string;
  description: string;
  status: 'COMPLETED' | 'IN_PROGRESS' | 'NOT_STARTED';
  evidenceSummary: string;
  tests: string[];
};
