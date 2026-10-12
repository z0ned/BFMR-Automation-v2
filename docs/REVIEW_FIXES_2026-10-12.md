# Review fixes — 12 October 2026

Current project state, limitations, and continuation instructions are consolidated in [Solution Design Specification v1.9](BFMR_Solution_Design_Specification_v1.9.pdf) and its [editable source](BFMR_Solution_Design_Specification_v1.9.md). This note records the review-fix implementation only.

## Implemented

- Tracker duplicate checks use exact authoritative deal IDs across all recognized open statuses. A conflicting ID never falls back to a title. New-reservation confirmation separately requires an exact reservation ID and quantity one. The email runner resolves the browser's canonical deal slug with the documented `GET /api/v2/deals/{slug}` response (`deal.deal_id`). Missing or ambiguous evidence stops the deal.
- Gmail intake requires an exact outer From mailbox plus Gmail authentication evidence: one `mx.google.com` Authentication-Results header, a Google receiving hop, DMARC pass for the sender domain, and aligned DKIM or SPF pass. Testing forwards require `BFMR_INTAKE_MODE=testing`; production is the default. Only unmodified authenticated Gmail API headers are trusted.
- Browser writes require positive account evidence and a common known reservation in the browser tracker and complete API tracker read. Unknown identity blocks writes. This replaces the former reminder-only account check.
- Gmail work payloads, dedupe tombstones, and the consumed cursor are atomically replaced and fsynced together in a private queue file. Restart resumes the saved cursor. A crashed PROCESSING item stops for reconciliation; it is never blindly replayed. Expired history persists a gap. Initial setup requires explicit permission to create a queue; a missing file is no longer silently treated as a new installation. INBOX membership and receipt ordering are checked.
- Duplicate detection, unpaid exposure and daily reconciliation share lifecycle classification. Unit payout fields multiply by quantity; total payout fields represent the whole row; conflicting amounts stop checkout. `amount_paid`, if provided, is subtracted. Terminal history does not require payout fields. The existing live exposure-contract validation gate remains required.
- Daily reconciliation retains every observed reservation, including terminal rows, status history, missing-since timestamps and persistent discrepancies with resolution timestamps. Missing open reservations remain discrepancies on later days, even without an Amazon ledger row.
- An engine acknowledgement without one exact tracker record becomes UNCERTAIN/REVIEW and opens an incident; no synthetic reservation ID is produced. Terminal or submitting commands cannot submit again.
- Blocks carry incident IDs. Resolving an incident clears only its blocks. Unassociated legacy blocks remain blocked for explicit investigation.
- The in-memory test database serializes transactions against isolated deep copies. Production engine mode requires an explicit PostgreSQL database. PostgreSQL commits all business state atomically in a JSONB account row using `SELECT ... FOR UPDATE`; a dedicated session advisory lock owns the account across processes. Lock loss blocks transactions and closes the browser through the registered handler. The live runner uses this same account lock before browser/queue work. Migration: `src/db/migrations/002_runtime_state.sql` (also created idempotently by initialization). The JSONB aggregate is an intentional storage implementation choice; this does not claim the old normalized tables are populated.
- The dashboard explicitly displays demonstration mode and unknown live operational status. Acceptance results begin pending, carry no fabricated evidence, and cannot turn green through a simulated run. Milestones carry no operational completion claim.
- Strict checking includes scripts/tests through `npm run typecheck:all`; the five reported TypeScript errors and stale orchestration/checkout fixtures were corrected.

## Setup before the next live run

Use the existing private environment configuration; do not commit credentials.

- `DATABASE_URL`: PostgreSQL connection for the single-account worker, with permission to create/use `bfmr_runtime_state`.
- `BFMR_EXPECTED_ACCOUNT`: exact visible account identity, shared consistently by runner and engine.
- `BFMR_INTAKE_MODE=testing` explicitly enables authenticated mail from `matt.ward@live.com`; omit or set `production` for BFMR mail only.
- `BFMR_GMAIL_QUEUE_PATH`: optional private state path, default `~/.local/state/bfmr/gmail-intake.json`. Back it up with the other runtime journals. For a genuinely first setup only, set `BFMR_INITIALIZE_GMAIL_QUEUE=YES`, then remove that setting. Restore an existing queue rather than creating a new baseline after data loss. A PROCESSING item or history gap requires reconciliation before any state repair.
- `BFMR_ACCOUNT_IDENTITY_SELECTOR`: a verified selector for exactly one visible account identity field on the authenticated tracker page.
- `BFMR_TRACKER_BROWSER_URL`: verified HTTPS browser tracker URL on the same trusted BFMR origin as the deal page.
- `BFMR_ACCOUNT_PROOF_RESERVE_ID`: a known reservation ID belonging to the expected account.
- `BFMR_ACCOUNT_RESERVATION_SELECTOR`: verified visible tracker row selector. Currently its row contract requires exact `data-reserve-id` and `data-deal-id` attributes. If BFMR's actual markup differs, adapt this extractor from a sanitized fixture before enabling writes. No account/API identity endpoint is assumed.

The BFMR account DOM contract and real Gmail authentication-header layouts remain unvalidated live. They intentionally stop automation when evidence is absent. An account with no common tracker reservation cannot yet prove browser/API alignment through this mechanism. No live reservation, purchase, tracking mutation, Telegram message or production database migration was performed during this fix.

## Verification

- Application TypeScript check, extended strict scripts/tests check, and production build pass.
- Offline suite: 118 pass, zero failures, one PostgreSQL integration test skipped unless a dedicated test URL is set.
- PostgreSQL integration is separately run on a disposable PostgreSQL 18 cluster with synthetic data: restart durability, rollback, exclusion of a second Node process, and ownership-connection loss. No production database is used.
- Browser tests run with synthetic intercepted requests, including wrong-account and mismatched browser/API reservation evidence. Passing fixtures do not establish the live DOM contract.

To run PostgreSQL regression yourself, set `BFMR_TEST_DATABASE_URL` to a disposable test database and run `node --import tsx --test tests/postgres_database.test.ts`. Never point that setting at the production database.
