# Open issues and implementation inputs

These items do not reopen settled MVP 1 scope. Separate a product decision from an external fact that must be verified and from a setup input.

## OQ-001 Recovery after Gmail history expires

**Type:** unresolved requirement boundary.

The user requires catch-up after downtime. V1.5 implements this using the saved Gmail history cursor while retaining the earlier prohibition on Inbox sweeps. If Gmail rejects an expired cursor, the specified behavior is to preserve the gap, alert and stop new intake. Restart cannot silently reset it.

This does not guarantee catch-up after arbitrarily long downtime. If that guarantee is required, Matt must decide whether a bounded recovery Inbox scan is permitted. Implement the documented stop-and-alert behavior in the meantime; do not silently broaden access or claim lossless recovery.

## EV-001 BFMR browser identity and quantity

**Type:** integration evidence, G-001.

Prove direct email-link navigation, expected account identity, canonical deal_id extraction, correct form/offer association, bundle quantity-one meaning and variant selection. Unknown identity cannot submit. Historical observations are not target-environment test results.

## EV-002 My Tracker contract

**Type:** integration evidence, G-001.

Verify required fields, pagination completion, date-filter semantics/timezone, RID, deal/status/quantity/offer mapping, account alignment, active-reservation coverage, immediate visibility and manual-release removal. The supplied reference's empty-object response sample is insufficient.

If immediate visibility cannot be proved, an empty result after an uncertain click cannot authorize automatic resubmission. Do not rely on a 24-hour date window if evidence shows active reservations can be older.

## EV-003 Email authentication and templates

**Type:** integration evidence, G-002.

Obtain sanitized direct and forwarded MIME/authentication examples. Verify trusted Gmail evidence, link preservation, both subject formats, repeated links, bundles versus multiple distinct deals, and extra-slot notices.

## SETUP-001 Secure service configuration

**Type:** environment input.

Required: Gmail account/OAuth setup, Google project/topic/pull subscription, BFMR expected account and API credentials, dedicated browser login profile, Telegram bot/private chat, Ubuntu desktop/service access, PostgreSQL and backup destination. Supply secrets through secure local configuration, never Git or chat.

## SETUP-002 Versions and operational evidence

**Type:** engineering setup and validation.

Pin compatible runtime/dependency versions during implementation. Validate headed browser boot/login, singleton ownership, encrypted backups and restore. Repository creation and the PDF do not establish those capabilities.

## Deferred items

Financial evaluation, purchasing, cancellation API contracts, shipment/payout handling, multi-deal mail and additional-slot notifications are outside MVP 1. V1.5 page 19 preserves earlier discussion without activating it.
