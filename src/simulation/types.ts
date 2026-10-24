import type { ReservationReference } from '../services/amazonEvaluation';
import type { ProviderTrackerRow } from '../providers/interfaces';

export type ScenarioPhase = 1 | 2 | 3 | 4 | 5 | 6;

export interface SimulatedDeal {
  dealId: string;
  slug: string;
  title: string;
  dealUrl: string;
  retailer: string;
  isClosed: boolean;
  availableSlots: number;
  payoutCents: number;
  retailCents: number;
  asin?: string;
}

export interface SimulatedReservation {
  reserveId: string;
  dealId: string;
  accountId: string;
  quantity: number;
  status: 'reserved' | 'cancelled' | 'purchased' | 'delivered';
  createdAt: string;
}

export type FaultType =
  | 'FAIL_BEFORE_COMMIT'
  | 'DROP_CONFIRMATION_AFTER_COMMIT'
  | 'DELAY_VISIBILITY'
  | 'INCOMPLETE_READ'
  | 'AUTH_CHALLENGE';

export interface ScriptedFault {
  id: string;
  targetOp: 'VERIFY_SESSION' | 'SUBMIT_RESERVATION' | 'RESOLVE_DEAL' | 'TRACKER_READ' | 'CANCEL_RESERVATION';
  faultType: FaultType;
  triggerOnAttempt: number;
  errorDetail?: string;
}

export interface ScenarioDefinition {
  id: string;
  name: string;
  phase: ScenarioPhase;
  description: string;
  expectedOutcome: string;
  initialDeals: SimulatedDeal[];
  initialReservations?: SimulatedReservation[];
  faults?: ScriptedFault[];
  sampleEmail: {
    subject: string;
    body: string;
    sender: string;
  };
}

export interface SimulationRunRecord {
  runId: string;
  scenarioId: string;
  scenarioName: string;
  phase: ScenarioPhase;
  status: 'IDLE' | 'RUNNING' | 'STEPPING' | 'COMPLETED' | 'PAUSED' | 'FAILED';
  createdAt: string;
  virtualTime: string;
  stepCount: number;
  activeFaults: ScriptedFault[];
  logs: Array<{
    timestamp: string;
    level: 'INFO' | 'WARN' | 'ERROR';
    category: 'PROVIDER' | 'WORKFLOW' | 'TELEGRAM' | 'SYSTEM';
    message: string;
    details?: unknown;
  }>;
}

export interface StateComparisonDiff {
  runId: string;
  evaluatedAt: string;
  isSynchronized: boolean;
  providerReservations: SimulatedReservation[];
  applicationReservations: Array<{
    id: string;
    bfmrReservationId: string;
    dealId: string;
    status: string;
    quantity: number;
    payoutCents: number;
  }>;
  matches: Array<{
    reserveId: string;
    dealId: string;
    quantity: number;
    providerStatus: string;
    appStatus: string;
  }>;
  discrepancies: Array<{
    reserveId: string;
    dealId: string;
    reason: string;
    providerStatus: string;
    appStatus: string;
  }>;
  missingInApp: SimulatedReservation[];
  missingInProvider: Array<{
    id: string;
    bfmrReservationId: string;
    dealId: string;
  }>;
}
