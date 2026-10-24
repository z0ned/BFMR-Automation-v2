# BFMR Provider Interface & Scenario Simulator (Phase 1: Reservations)

A self-contained scenario simulator and management console for the BFMR automation system. It allows operators to execute real application reservation workflows against high-fidelity simulated BFMR provider endpoints and browser actions, verifying recovery, state reconciliation, and fault handling in complete safety.

## User Review & Critical Decisions

> [!IMPORTANT]
> The following architectural parameters were confirmed during interactive clarification and govern the implementation:

- **Confirmed Scope — Phase 1 Priority**: The initial implementation focuses exclusively on **Phase 1: Reservations**, delivering the unified provider interface bundle, run-isolated data separation, synthetic scenario engine, and the scenario management console. Purchases, tracking, cancellations, payments, and insurance will remain stubbed as explicit unsupported phase boundaries until subsequent phases.
- **Confirmed UI Architecture — React + Vite with Express API**: The scenario management console is delivered as an interactive React application powered by Tailwind CSS and Vite, mounted alongside an Express backend that runs the simulation controller, execution harness, and local simulator service.
- **Confirmed Database Backing — PGlite Self-Contained Persistence**: Provider simulation state and application run databases will be instantiated using `@electric-sql/pglite`. This provides strict PostgreSQL dialect fidelity and table-level separation without requiring manual external PostgreSQL container lifecycle management, while maintaining compatibility with the canonical `database/schema.sql` definitions.
- **Run Isolation & Mode Gating**: The simulation profile operates strictly under `BFMR_INTAKE_MODE=testing` with `BFMR_PROVIDER_MODE=simulation`. No live BFMR credentials, browser profiles, or production database records are ever touched or queried.

---

## 1. Overview & Core Concept

- **What It Does**: The simulator models BFMR's HTTP API and Playwright browser reservation flows under reproducible test scenarios (e.g. single-deal success, multi-deal reservation bursts, lost browser confirmations, out-of-stock deal closures, and incomplete tracker pagination). The web dashboard enables operators to select a scenario, inspect initial provider conditions, execute the real application workflow against the simulator, advance virtual clocks, and verify that the application's persisted business state matches provider reality.
- **Target Audience / Persona**: Automation operators and test engineers needing to validate deal intake, reservation limits, and edge-case recovery logic without risking real BFMR account penalties or financial exposure.
- **Key Value**: Replaces guesswork and risky live-account testing with deterministic, repeatable scenario runs where faults (such as drop-before-commit or lost-confirmation-after-commit) can be injected and reconciled with zero live provider side effects.

---

## 2. User Experience & Visual Design

### Key User Flows

1. **Scenario Selection & Inspection**:
   - Operator lands on the **BFMR Test Simulator** dashboard.
   - Left sidebar displays the **Scenario Library** grouped by phase (active: *Phase 1 — Reservations*).
   - Selecting a scenario loads its metadata: title, description, expected outcome, seed configuration, simulated BFMR deals, and scripted fault injections.
2. **Run Initialization & Execution**:
   - Operator clicks **Create Run**. The backend spins up two isolated PGlite instances: one for simulated provider truth (`bfmr_simulator`) and one for the application workflow run (`bfmr_test_sim_<id>`).
   - The status panel prominently displays the active run identity, pinned configuration digest, and live test mode indicators.
   - Operator clicks **Execute Step / Run Workflow** or triggers synthetic deal email intake to initiate reservation processing.
3. **Timeline & State Diff Comparison**:
   - The central workspace displays an interactive comparative view:
     - **Provider Truth**: Actual deals, reservations, and slot allocations held in the simulator.
     - **Application State**: Workflow state, recorded reservation records, and transition journals recorded by the engine.
     - **State Reconciler & Diffs**: Real-time diff highlight indicating whether application records agree with provider truth or if reconciliation is required.
4. **Fault Injection & Virtual Clock Control**:
   - Controls allow the operator to simulate edge cases on demand: drop browser confirmation, simulate tracker 500 error, expire reservations, or advance simulated time past expiration deadlines.

### Visual Identity & Theme

- **Aesthetic Direction**: Utilitarian, mission-critical engineering console. Dark slate architecture with clear typography, high-contrast operational status signaling, and zero decorative fluff.
- **Color Palette & Mood**:
  - Dominant Neutral Canvas (60%): Deep slate background (`#0B0F17`) and structural paneling (`#111827`).
  - Structural Borders & Dividing Surfaces (30%): Hairline borders (`#1F2937`) with subtle contrast deltas.
  - Accent Budget (10%): High-intent action colors: Cobalt blue (`#2563EB`) for primary runs, Emerald (`#10B981`) for confirmed agreement, Amber (`#F59E0B`) for uncertainty/reconciliation required, and Crimson (`#EF4444`) for rejected or faulted steps.
- **Typography & Hierarchy**:
  - Display & Headings: `Plus Jakarta Sans` or clean neo-grotesque sans for structural navigation and titles.
  - Prose & Labels: Clean, unboxed text labels with typographic separators (`·`, `/`).
  - Data, Telemetry & IDs: Tabular monospace figures (`font-mono tabular-nums`) for run IDs, reservation IDs, timestamps, and financial values.
- **Component Styling & Layout**:
  - Top Bar Contract: 3-zone contract featuring the system wordmark, scenario navigation breadcrumb, and mode status indicators.
  - 3-Column Studio Workspace: Left sidebar (Scenario catalog & run controls), Central viewport (State timeline & comparison matrices), Right panel (Audit events, simulated Telegram alert logs, and fault controls).

---

## 3. Key Product Decisions & Trade-Offs

### Decision 1: Provider Bundle Injection Pattern
- **Chosen Approach**: Introduce a run-pinned `ProviderBundle` abstraction comprising `IBfmrApi`, `IBfmrBrowser`, `IAmazonProvider`, `ITelegramNotifier`, and `IClock`. The workflow services (`bfmrWorker.ts`, `dealEmailWorkflow.ts`) consume this bundle rather than importing singleton adapters directly.
- **Why**: Keeps business logic and policy enforcement identical across live operation and simulation. The application code executes the exact same validation and state transitions in both environments.
- **Alternatives Considered**: Mocking HTTP calls with network interceptors or mocking class prototypes. Rejected because it risks leaking live state and doesn't model browser DOM actions cleanly.

### Decision 2: Dual-Store PGlite Isolation
- **Chosen Approach**: Two isolated PGlite instances per run. The simulator store holds provider deals, slots, and reservations. The application store executes canonical migrations from `database/schema.sql` and holds application business records.
- **Why**: Preserves the realistic boundary where a provider action can succeed even if application persistence fails, accurately reflecting real-world distributed failure modes.
- **Alternatives Considered**: In-memory JavaScript objects. Rejected because SQL schema constraints, transactional semantics, and advisory locking are core requirements of the BFMR automation architecture.

### Decision 3: Synthetic Reservation Scenarios (Phase 1 Baseline)
- **Chosen Approach**: Seed Phase 1 with 5 standard synthetic test scenarios:
  1. *Standard Single-Deal Reservation*: Normal happy path; deal available, reservation confirmed, tracker verified.
  2. *Supported Multi-Deal Announcement*: Multiple distinct deals announced in one email; reserves quantity 1 for each offer before evaluation.
  3. *Committed Reservation, Confirmation Lost*: Simulated browser timeout after BFMR backend commit; tests that application halts for reconciliation without re-submitting.
  4. *Deal Closed / No Slots Available*: Deal slots exhausted; verifies clean rejection without retry.
  5. *Incomplete Tracker Read*: Simulates pagination failure or missing tracker rows; verifies application does not assume absence.
- **Why**: Covers all critical safety and recovery invariants specified in `docs/BFMR_Solution_Design_Specification_v22.md` and `docs/PROVIDER_SIMULATION_PROPOSAL.md`.

---

## 4. Technical Architecture & Data Strategy

### System Architecture Diagram

```
┌────────────────────────────────────────────────────────────────────────┐
│                        BFMR Scenario Web Studio                        │
│                (React + Vite on Port 3000 + Express API)               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTP / REST / Events
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   Simulation Controller & Run Manager                  │
│   - Run Lifecycle (Create, Start, Step, Pause, Archive)                │
│   - Virtual Clock & Fault Injection Orchestrator                       │
│   - State Reconciliation Inspector (Read-only Provider vs App)         │
└───────────────┬────────────────────────────────────────┬───────────────┘
                │ Injected Provider Bundle               │ Workflow SQL
                ▼                                        ▼
┌───────────────────────────────┐        ┌───────────────────────────────┐
│     Simulated Provider        │        │      Application Worker       │
│   - Simulated BFMR API        │        │   - dealEmailWorkflow.ts      │
│   - Simulated Browser Actions │        │   - relationalReservations.ts │
│   - Virtual Clock & Faults    │        │   - dealEmailReconciliation.ts│
└───────────────┬───────────────┘        └───────────────┬───────────────┘
                │ Reads / Writes                         │ Reads / Writes
                ▼                                        ▼
┌───────────────────────────────┐        ┌───────────────────────────────┐
│     Simulator State Store     │        │    Application Test Store     │
│   (PGlite: bfmr_simulator)    │        │   (PGlite: bfmr_test_sim_*)   │
│  - sim_scenarios              │        │  - canonical schema.sql       │
│  - sim_runs                   │        │  - deal_reservations          │
│  - sim_deals & sim_offers     │        │  - deal_intake_queue          │
│  - sim_reservations           │        │  - workflow_evidence          │
│  - sim_fault_rules            │        │  - workflow_journals          │
│  - sim_events & audit_log     │        │                               │
└───────────────────────────────┘        └───────────────────────────────┘
```

### Data Model & State Stores

1. **Simulator Store (`bfmr_simulator` via PGlite)**:
   - `sim_scenarios`: Pre-configured scenario definitions, parameters, and expected outcomes.
   - `sim_runs`: Active and archived runs, configuration digests, random seed, virtual time, and status.
   - `sim_deals`: Simulated BFMR deals, URLs, retailers, and item terms.
   - `sim_offers`: Offer IDs, payouts, and available reservation slots.
   - `sim_reservations`: Provider-side reservations (`reserve_id`, `deal_id`, `offer_id`, `status`, `created_at`).
   - `sim_fault_rules`: Active fault injection rules (e.g. `OP_SUBMIT_ONE -> COMMIT_THEN_DROP_RESPONSE`).
   - `sim_audit_log`: Chronological ledger of every API request and browser action simulated.

2. **Application Run Store (`bfmr_test_sim_<run_id>` via PGlite)**:
   - Initialized with canonical `database/schema.sql`.
   - Records true application persistence: `deal_reservations`, `deal_intake_queue`, `workflow_evidence`, and advisory locks.

3. **Comparison Engine**:
   - Independent, read-only diff evaluator that queries both PGlite instances and correlates by `deal_id`, `offer_id`, and `reserve_id`.
   - Produces structured comparison payloads:
     - `matched`: Records matching on status and quantities.
     - `discrepancy`: Status mismatch (e.g. Provider has `RESERVED`, App has `UNCERTAIN` or `RESERVING`).
     - `missing_in_app`: Provider reservation exists but application has no record.
     - `missing_in_provider`: Application recorded reservation but provider has none.

---

## 5. Implementation Stages & Build Steps

1. **Stage 1: Core Provider Interfaces & Simulation Engine (`src/simulation/`)**:
   - Define clean TypeScript interfaces for `ProviderBundle`, `IBfmrApi`, `IBfmrBrowser`, `IClock`, and `IFaultManager`.
   - Implement the PGlite-backed `SimulatedBfmrApi` and `SimulatedBfmrBrowser`.
   - Implement fault rule evaluator (`before-commit-fail`, `after-commit-drop`, `delayed-visibility`).
2. **Stage 2: Scenario Catalog & Runner (`src/simulation/scenarios/`)**:
   - Create catalog of standard Phase 1 scenarios with synthetic data and assertion rules.
   - Implement run orchestrator: creates isolated PGlite databases, sets up initial provider state, and executes application workflow turns.
3. **Stage 3: Express Simulation Controller API (`server/`)**:
   - Endpoints for scenario listing, run creation, step execution, fault triggers, time advancement, and state diff queries.
4. **Stage 4: React Scenario Management Console (`src/ui/`)**:
   - Build scenario library browser, active run dashboard, dual-state comparison timeline, and manual fault injection controls.
   - Integrate with Express backend in Vite dev/preview server.
5. **Stage 5: Verification & Safety Gating**:
   - Verify all 5 Phase 1 scenarios pass deterministic evaluation.
   - Enforce startup configuration validation ensuring `BFMR_PROVIDER_MODE=simulation` cannot be initiated when `BFMR_INTAKE_MODE=production`.
