# BFMR Automation v2

Fresh implementation of the BFMR reservation MVP. This repository currently contains the design and implementation handoff only; no application has been implemented or validated.

## Authoritative design

Read [Solution Design Specification v1.5](docs/BFMR_Solution_Design_Specification_v1.5.pdf). It supersedes conflicting instructions in earlier BFMR documents. Later explicit instructions from Matt take precedence.

The earlier BFMR codebase is not the starting point. Do not import or migrate it by default.

## MVP 1 behavior

1. Receive a qualifying single new-deal email through Gmail watch and Google Pub/Sub.
2. Open the trusted BFMR deal link in a dedicated authenticated browser and establish the deal identity.
3. Use the My Tracker API to check for an existing active reservation for that deal. Skip if one exists, including a manual reservation or another color.
4. Submit quantity 1 through the BFMR website form using Playwright.
5. Confirm the outcome using My Tracker; reconcile uncertain results before any retry.
6. Leave the reservation in place. Matt manages all releases manually.

Any retailer and bundle deals are allowed. No financial, profitability, retailer-stock or retailer-eligibility checks are performed. Multiple-deal emails and additional-slot notifications are ignored. There is no purchasing, automatic cancellation or one-minute release. Both testing and production modes make real reservations.

Persist the Gmail history cursor and catch up after downtime, with durable deduplication. The expired-history limitation is documented in the specification and [open issues](docs/OPEN_ISSUES.md).

## Technical direction

- Single Ubuntu host, Node.js and TypeScript.
- Local PostgreSQL for durable intake, queue, attempts and audit records.
- Playwright bundled Chromium in headed mode, with a secured desktop for manual login/MFA.
- Website form submission only; no reservation-creation API or reconstructed HTTP request.
- My Tracker API for duplicate and confirmation reads.
- Pub/Sub pull, outbound connectivity and no public webhook.
- Telegram incidents, local CLI and operational recovery as defined in v1.5.

## Handoff contents

| File | Purpose |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Instructions and boundaries for a coding agent |
| [Design PDF](docs/BFMR_Solution_Design_Specification_v1.5.pdf) | Complete requirements, architecture, contracts and acceptance criteria |
| [Implementation plan](docs/IMPLEMENTATION_PLAN.md) | Milestones and required evidence |
| [Decision register](docs/DECISIONS.md) | Final scope and supersession summary |
| [Open issues](docs/OPEN_ISSUES.md) | Unresolved decisions, integration evidence and setup inputs |

No dependencies, application commands or runtime versions have been invented for this handoff. Establish and document them during implementation. No acceptance tests or live BFMR checks have been run in this repository yet.

## Starting implementation

Ask the coding agent to implement MVP 1 from v1.5 as a fresh project, following AGENTS.md and the implementation plan. Provide required service access securely. Start with the repository bootstrap and offline tests; satisfy the documented evidence gates before live enablement.

The repository contains no credentials, browser profiles or private email/account fixtures. Never paste secrets into issues, chat, commits or test evidence.
