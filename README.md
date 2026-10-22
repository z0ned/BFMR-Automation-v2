# BFMR Automation v2

Fresh TypeScript implementation for BFMR email reservations and the separately authorized Amazon workflows. The repository contains active live scripts, offline tests, and an incomplete orchestration engine. It is not a deployed unattended production service.

## Current authoritative handoff

Read the current [v22 design](docs/BFMR_Solution_Design_Specification_v22.md), [implementation reference](docs/BFMR_Implementation_v22..md), [relational integration runbook](docs/RELATIONAL_INTEGRATION.md) and [database guide](database/README.md). [AGENTS.md](AGENTS.md), [DECISIONS.md](docs/DECISIONS.md), [IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) and [OPEN_ISSUES.md](docs/OPEN_ISSUES.md) preserve the operating rules, current evidence and historical context. Dated evidence retains its original scope; Git history preserves earlier revisions.

Later explicit user decisions supersede conflicting historical documents. Email and PDF examples, code comments, test output, and the presence of a live script do not authorize external actions. Preserve the existing dirty working tree and private runtime state.

## Current behavior

The interactive email runner accepts authenticated BFMR new-deal mail and, in explicit testing mode, authenticated mail from `matt.ward@live.com`. It validates trusted deal links, saves Gmail messages and cursor together, makes one BFMR reservation per announced deal, then checks confirmed reservations for Amazon eligibility. The approved order path uses a $100 per-order ceiling, BFMR payout at least the complete order total, and no more than $200 in existing unpaid BFMR payout exposure plus the proposed Amazon cost. It marks purchases as gifts, verifies free non-Prime shipping, matches orders to the submission that just completed, and persists supported order/tracking data locally.

A separate daily process in the active runner checks Amazon Order History after 03:00 Atlanta time and reconciles official BFMR status, with Telegram discrepancy alerts. BFMR order/tracking writes are bound to exact reservations and require readback. These retailer selectors and BFMR write contracts have not been validated live as a complete workflow.

The worker source uses relational PostgreSQL business repositories with dedicated account ownership and a separate SQL Gmail intake store. Batch/recovery, daily status and alert-delivery journals remain private files. The older JSONB engine remains a separate compatibility/model path. Account selectors, Gmail auth-header arrangements, provider field contracts, native PostgreSQL/schema/cutover acceptance, backup/restore and supervised deployment remain open. Do not call the project production-ready.

## Database source

The authoritative 16-table schema is [database/schema.sql](database/schema.sql), with [upgrade migrations](database/migrations/) and [design notes](database/DESIGN_DECISIONS.md) in this repository. It includes immutable reservation creation terms, one order per reservation, one shipment/tracking number per order and one reimbursement per reservation. No separate schema checkout is needed. See [database/README.md](database/README.md) for source provenance, fresh-install versus upgrade boundaries and offline checks. Startup never applies SQL automatically.

## Commands

```bash
npm test
npm run test:relational
npm run test:gmail-intake
npm run typecheck
npm run typecheck:all
```

Run software tests only when the user requests testing or verification. Commands below have real external effects and require the exact gates and setup in the current v22 implementation reference:

- `npm start`: push-intake worker; may reserve/purchase under existing gates. It does not create a temporary startup test reservation. Source is not production acceptance.
- `npm run test-real-email` / `npm run test-real-email-e2e`: real BFMR intake/reservations and potentially Amazon purchases.
- `npm run test-bfmr-ipad-reservation`: live BFMR test reservation/startup workflow.
- `npm run test-amazon-checkout`: live BFMR startup reservation/cleanup, then Amazon rehearsal stopping before order submission.
- `npm run test-amazon-purchase -- --max-total <USD>`: can place the specifically authorized fixed-item Amazon purchase after final terminal approval.
- `node --import tsx scripts/test_multi_deal_pdf.ts [path]`: local PDF parsing exercise only.

The dedicated PostgreSQL integration test requires a disposable `BFMR_TEST_DATABASE_URL`; never use production state for a test.
`npm run test:relational` instead uses the bundled schema and disposable PGlite, with no database URL or external schema path required.

## Configuration and private data

Use [.env.example](.env.example) as the configuration template, merging missing entries into an existing private `.env` without replacing credentials. Production CON-001 requires Gmail watch/Pub/Sub StreamingPull; periodic Gmail polling and Inbox sweeps are forbidden. Configure the exact Gmail mailbox/OAuth identity, Pub/Sub topic/subscription and a verified Pub/Sub credential identity. The worker now uses owned StreamingPull, commits notification evidence before ACK and commits admitted work with its consumed cursor. Startup/reconnect history continuation and daily watch renewal preserve cursor identity; no idle timer reads Gmail. Install the separate reviewed operational SQL and reconcile any legacy queue before a separately authorized live run. Offline tests cover simulated adapters and embedded SQL; native/provider and supervised-service acceptance remain open. See [production intake runbook](docs/GMAIL_PRODUCTION_INTAKE.md). IMAP and local inbound-listener utilities are not production substitutes.

Amazon retailer identity comes from the database: require exactly one `retailers` row where `name = 'Amazon'`, then select its account with `ORDER BY retailer_account_ranking ASC LIMIT 1`. Multiple accounts are valid; zero linked accounts stop startup. Rankings are required integers unique within each retailer, with no default or automatic assignment. The selected account is fixed for the run; changed selection stops work instead of switching accounts. IDs/email/rank require no environment values, and selection never reads `ccv`. Existing databases require the reviewed prepare → manual rank backfill → finalization process in the [relational runbook](docs/RELATIONAL_INTEGRATION.md); startup rejects an unfinished upgrade. Existing least-privilege roles need SELECT on the ranking column, without application permission to update it. The worker handles one selected account per run, not tracking across all accounts; review outstanding orders on other accounts before changing priorities. Existing orders retain their original account identity.

Environment loading is described in the v22 implementation reference. Keep credentials, browser profiles, OAuth files, message content, Amazon order/tracking details, PostgreSQL data and runtime journals out of Git and logs. First-time Gmail queue creation requires an explicit `BFMR_INITIALIZE_GMAIL_QUEUE=YES`; never use it to replace a lost existing queue.

Sample PDFs under `docs/sample_emails/from_bfmr` are parser reference material only. They are not authentication evidence and do not authorize live reservation, cancellation, ordering or tracking actions.
