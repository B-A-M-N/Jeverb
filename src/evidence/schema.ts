export type EvidenceSchemaVersion = 1;

/**
 * Provenance schema additions (additive, optional-only — schema stays 1).
 * Re-exported here so consumers can discover them without importing the
 * ledger writer; the canonical definitions live in `ledger.ts`.
 */
export type { EvidenceRecord, ReceiptOutcome, LedgerTargetError, LedgerTargetCheck, LedgerRead, LedgerCorrupt } from "./ledger.js";
export { RECEIPT_OUTCOMES, resolveEventHost } from "./ledger.js";
