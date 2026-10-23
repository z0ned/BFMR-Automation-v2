-- ====================================================================
-- BFMR Automation v2 - PCI-DSS Compliance Migration: Drop CCV
-- ====================================================================
-- Automated Amazon 1-Click checkout selects credit cards by last-4 digits;
-- plaintext CCV storage is unnecessary and violates PCI-DSS requirements.

ALTER TABLE public.retailer_accounts DROP COLUMN IF EXISTS ccv;
