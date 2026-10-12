# BFMR Automation v2

Fresh TypeScript implementation for BFMR email reservations and the separately authorized Amazon workflows. The repository contains active live scripts, offline tests, an incomplete orchestration engine, and a simulated dashboard. It is not a deployed unattended production service.

## Current authoritative handoff

Read [Solution Design Specification v1.9](docs/BFMR_Solution_Design_Specification_v1.9.pdf) for the current requirements, implemented behavior, assumptions, evidence, setup, source map, and open work. The editable companion is [v1.9 Markdown](docs/BFMR_Solution_Design_Specification_v1.9.md). Then read [AGENTS.md](AGENTS.md), [DECISIONS.md](docs/DECISIONS.md), [IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md), and [OPEN_ISSUES.md](docs/OPEN_ISSUES.md). v1.5-v1.8 are historical versions; they are retained for traceability and do not override v1.9.

Later explicit user decisions supersede conflicting historical documents. Email and PDF examples, code comments, test output, and the presence of a live script do not authorize external actions. Preserve the existing dirty working tree and private runtime state.

## Current behavior

The interactive email runner accepts authenticated BFMR new-deal mail and, in explicit testing mode, authenticated mail from `matt.ward@live.com`. It validates trusted deal links, saves Gmail messages and cursor together, makes one BFMR reservation per announced deal, then checks confirmed reservations for Amazon eligibility. The approved order path uses a $100 per-order ceiling, BFMR payout at least the complete order total, and no more than $200 in existing unpaid BFMR payout exposure plus the proposed Amazon cost. It marks purchases as gifts, verifies free non-Prime shipping, matches orders to the submission that just completed, and persists supported order/tracking data locally.

A separate daily process in the active runner checks Amazon Order History after 03:00 Atlanta time and reconciles official BFMR status, with Telegram discrepancy alerts. BFMR order/tracking writes are bound to exact reservations and require readback. These retailer selectors and BFMR write contracts have not been validated live as a complete workflow.

PostgreSQL-backed transactions and cross-process advisory ownership exist in `src/db/postgresDatabase.ts`; the live runner uses PostgreSQL ownership but its Gmail queue and order/status journals remain separate private files. The React dashboard is demonstration-only. Account selectors, Gmail auth-header arrangements, provider field contracts, backup/restore and supervised production deployment remain open. Do not call the project production-ready.

## Commands

```bash
npm test
npm run typecheck
npm run typecheck:all
npm run build
npm run dev
```

`npm test` and build are software checks; do not run them unless the user requests testing or verification. Commands below have real external effects and require the exact gates and setup in v1.9:

- `npm run test-real-email` / `npm run test-real-email-e2e`: real BFMR intake/reservations and potentially Amazon purchases.
- `npm run test-bfmr-ipad-reservation`: live BFMR test reservation/startup workflow.
- `npm run test-amazon-checkout`: live BFMR startup reservation/cleanup, then Amazon rehearsal stopping before order submission.
- `npm run test-amazon-purchase -- --max-total <USD>`: can place the specifically authorized fixed-item Amazon purchase after final terminal approval.
- `node --import tsx scripts/test_multi_deal_pdf.ts [path]`: local PDF parsing exercise only.

The dedicated PostgreSQL integration test requires a disposable `BFMR_TEST_DATABASE_URL`; never use production state for a test.

## Configuration and private data

Environment loading is described in v1.9. Keep credentials, browser profiles, OAuth files, message content, Amazon order/tracking details, PostgreSQL data and runtime journals out of Git and logs. First-time Gmail queue creation requires an explicit `BFMR_INITIALIZE_GMAIL_QUEUE=YES`; never use it to replace a lost existing queue.

Sample PDFs under `docs/sample_emails/from_bfmr` are parser reference material only. They are not authentication evidence and do not authorize live reservation, cancellation, ordering or tracking actions.
