# Production Gmail intake — implementation and operator runbook

**Updated 22 October 2026 — source implementation and offline tests.** The source was implemented on 21 October; the user subsequently requested offline intake testing. Current results and limits are recorded below. No native database installation/import, Gmail watch, Pub/Sub connection, BFMR/Amazon action or deployment was invoked. Earlier test counts describe their own revisions.

## Contract and source

CON-001 requires Gmail INBOX watch and outbound Pub/Sub StreamingPull. There is no periodic Gmail polling, Inbox sweep, public webhook or IMAP production fallback. `gmailPushTransport.ts` owns the StreamingPull connection/reconnect lifecycle; `productionGmailIntake.ts` coordinates independent intake; `postgresGmailIntake.ts` stores its operational state. The existing business/provider/purchase gates still apply.

Under dedicated BFMR account ownership, startup verifies the configured Gmail mailbox against OAuth, validates the subscription/topic association, records a STARTING run, establishes the watch, starts StreamingPull, then commits ACTIVE before releasing buffered callbacks. Watch baseline/expiration remain separate from the consumed history cursor. Startup and reconnect perform one saved-history continuation; later reads are triggered by durably recorded notifications. Daily watch renewal, stream keepalive/lease maintenance and local browser scheduling timers do not poll Gmail history.

Each valid, rejected or repeated notification is durably inserted/verified before ACK. Poison evidence retains a payload hash and rejection label, not raw notification content. Complete history pages and distinct fetched messages are validated before classifications, queued work, notification consumption and cursor advancement commit atomically. Work retains Gmail-ID tombstones. Intake continues while browser work or an interactive recovery pause is blocked; the browser consumer remains serial.

Triggered transient Gmail reads have bounded retries and honor valid `Retry-After` delays up to 60 seconds; invalid or longer requirements stop for review rather than retrying early. Failed fetches/pages do not advance the cursor. Unavailable persistence cannot fall through to ACK. Intake failure or ownership loss blocks new browser work and stops the controlled session; a possible earlier external effect still requires reconciliation.

## Installation and configuration prerequisites

1. Stop the existing writer and preserve coordinated PostgreSQL/private-journal backups. Establish the actual business-schema baseline and accepted business cutover using the [relational runbook](RELATIONAL_INTEGRATION.md). Startup requires exactly one retailer named `Amazon` and selects its account with `ORDER BY retailer_account_ranking ASC LIMIT 1`; multiple accounts are valid, zero linked accounts stop startup. IDs/email/rank come from the database without environment overrides or a `ccv` read. The chosen account stays pinned for the run; changed selection stops work. Existing databases need reviewed nullable/unique preparation, manual rank backfill and `NOT NULL` finalization before worker validation can pass; ranking source remains uninstalled; [offline account tests](../database/README.md#offline-account-ranking-validation--22-october-2026) do not establish native acceptance.
2. Review and separately authorize installation of [database/gmail_intake.sql](../database/gmail_intake.sql) once. It adds four operational tables: `gmail_intake_state`, `gmail_intake_runs`, `gmail_intake_notifications` and `gmail_intake_work`. These remain separate from the 16-table [business schema](../database/schema.sql), whose current revision adds account ranking. Neither source file installs the other; runtime startup does no DDL.
3. Use a non-owning application role with SELECT, INSERT and UPDATE on these four tables, alongside its existing reviewed business grants. Existing least-privilege business roles also need SELECT on `retailer_accounts.retailer_account_ranking`, without application ranking updates. Do not grant `ccv` reads, schema ownership/management, table deletion/truncation or migration authority. Back up the operational tables together; queued bodies/headers and actual identifiers are private data.
4. Merge [.env.example](../.env.example) into private configuration without replacing credentials. The template now lists 43 variable names; Amazon retailer-account identity comes from the database. Production intake requires `GMAIL_ACCOUNT_EMAIL`, Gmail OAuth client/secret/refresh token, full `GOOGLE_PUBSUB_TOPIC` and `GOOGLE_PUBSUB_SUBSCRIPTION` resource names, and verified Pub/Sub credentials. `GOOGLE_APPLICATION_CREDENTIALS` selects a private container-visible file when that mechanism is used; separately verified ADC is another identity source. These are distinct from Gmail OAuth and BFMR API credentials.
5. Verify the real Google project/topic/subscription, Gmail publisher IAM, subscriber permissions, intended OAuth mailbox and current provider contracts. The subscription must refer to the configured topic, with no push endpoint, export destination, detached state or filtering. Source checks and variable presence are not evidence that Google is configured correctly.

Do not run the live worker merely to inspect configuration. The read-only BFMR identity diagnostic remains separate and does not configure Gmail intake.

The worker processes one selected Amazon account per run; it does not track all accounts. Before reprioritizing, stop it and review outstanding orders on other accounts, which can be outside the next run's ledger projection. Preserve each order's original account identity; see the relational runbook for the remaining tracking boundary.

## Preserve or import existing Gmail state

If the legacy private JSON queue ever existed, restore/reconcile it first. Startup will not import it or initialize a different baseline over it. Its accepted bytes/hash remain a recovery boundary after SQL import; do not delete or rewrite that source to bypass checks.

From the repository's **Ubuntu terminal**, with the writer stopped and private configuration available, the report-only command is:

```sh
node --import tsx scripts/import_gmail_intake.ts
```

The source defaults to `BFMR_GMAIL_QUEUE_PATH`, then the user's `~/.local/state/bfmr/gmail-intake.json`; `--source <private path>` selects another actual source. The report validates account/mailbox/schema/scope and shows source SHA-256, readiness and work counts without provider actions or database import. A history gap, interrupted PROCESSING work or conflicting SQL state requires review. Never edit those conditions into a fabricated empty queue.

Only after a reviewed report, preserved backups and separate authorization, import with the exact reviewed values:

```sh
node --import tsx scripts/import_gmail_intake.ts --apply \
  --confirm-account '<exact reviewed BFMR account>' \
  --confirm-source-sha256 '<reviewed source hash>'
```

Use the same `--source` when the report used an override, and configure the worker's `BFMR_GMAIL_QUEUE_PATH` to that accepted source. Apply retains the actual cursor, pending work, DONE tombstones and accepted source hash. Equal repeated input is idempotent; it cannot rewind SQL or replay completed work. The importer has no Gmail/watch/PubSub/browser/BFMR/Amazon action path.

If no queue ever existed and this is authentic first-ever SQL initialization, explicitly set `BFMR_INITIALIZE_GMAIL_QUEUE=YES` for that startup only, then remove it. The initial watch baseline becomes the consumed cursor; earlier Inbox mail is not swept. A missing previously used queue/database is a recovery fault, not first setup.

## Entrypoints and recovery

`npm start` runs the live production worker without a temporary startup CAPTCHA reservation. Existing `test-real-email` / `test-real-email-e2e` commands retain that separately scoped test startup reservation/cleanup. All can reach real provider effects when their independent gates pass; installing source is not live authorization.

An expired/rejected history cursor persists `GMAIL_HISTORY_GAP`; restart preserves it. PROCESSING work requires authoritative BFMR/Amazon reconciliation before operator repair. Restore SQL, private recovery journals and accepted source files consistently; never reset a cursor, blindly replay a task or repeat an uncertain provider action. Shutdown leaves the Gmail watch intact and unacknowledged/durable notifications recoverable. Notification and browser/provider transactions are not one atomic transaction.

## Offline validation — 22 October 2026

Run the dedicated suite with `npm run test:gmail-intake`. It uses synthetic Gmail/SDK/stream adapters, controlled coordinator failures and the actual `database/gmail_intake.sql` in disposable in-memory PGlite 0.5.10. A shared guard blocks socket/HTTP/TLS requests and removes provider/database environment configuration; no private configuration loader or live entrypoint is imported. Tests run serially without process isolation so named cases and counts remain visible in this environment.

**Result: 62 passed, zero failed, zero skipped** on Node 24.19.0: 20 transport cases, 14 SQL-store cases, 26 coordinator cases and two coordinator/SQL integration cases. The integration cases query committed notification evidence from the ACK callback, inject a notification COMMIT failure, and reconstruct the store/coordinator after ACK loss to verify pending recovery without replaying completed work. `npm run typecheck`, `npm run typecheck:all` and whitespace checks passed. At that checkpoint, the pinned business schema and both SQL source files were unchanged. Earlier runs/reruns are not added to this distinct-case count. These results preceded the subsequent ranked Amazon account/schema change; no software tests were added or run for that change.

Coverage includes persistence before ACK; duplicate/poison/ACK failures; startup activation; complete history pagination/fetch/MIME failures; cursor/watch independence; bounded retry/lease/reconnect behavior; more than one notification batch; intake during paused browser work; transaction/ownership rollback; persistent gaps; interrupted PROCESSING work; legacy import idempotency; and shutdown. Optional typed pool injection and a narrow coordinator persistence interface enable offline fixtures; production defaults and action gates remain unchanged. Results apply to simulated adapters and embedded SQL, not native roles/locking, actual Google contracts or supervised production operation.

## Evidence still required before production acceptance

- Complete separately scoped native/provider failure, process-crash, coordinated restore and supervised-operation acceptance; the offline suite covers modeled behavior only.
- Validate native PostgreSQL installation, actual schema-catalog deparsing/constraints, reviewed runtime grants, advisory ownership/loss and coordinated backup/restore. Static checks do not exercise SQL.
- Verify real mailbox/OAuth identity, Gmail watch permissions/expiration/renewal, publisher/subscriber IAM, StreamingPull reconnect/lease/ACK behavior, history paging/retention and actual authenticated mail templates. Record the exact account/session/code revision and bounded effects.
- Accept reboot/supervision, manual browser authentication, failed-alert handling, monitoring and operator recovery. Source implementation does not establish unattended readiness, and the independent single-deal purchase/delivery-cutoff gaps remain tracked in [OPEN_ISSUES.md](OPEN_ISSUES.md).
