import { attestationStatus, type ServiceAttestation } from "./client.js";
import type { MissionContract } from "../mission/contract.js";

/**
 * Operator-signed independent verifications, read from the root-owned
 * control service. The agent cannot write this store (same-UID file writes
 * are rejected by the service's ownership checks); only a PolicyKit-authorized
 * operator invocation of `jev-control attest-pass|attest-fail` records entries.
 *
 * Fail-open read: no service, no attestations, no behavior change.
 */
export async function readServiceAttestations(missionId: string, timeoutMs = 750): Promise<ServiceAttestation[]> {
  try {
    const status = await attestationStatus(missionId, timeoutMs);
    return status.attestations;
  } catch {
    return [];
  }
}

/**
 * Merge operator attestations for the contract's current mission revision
 * into `independentVerifications`. Pure: no IO, no mutation of inputs.
 *
 * Matching is deliberately narrow — missionId and missionRevision must equal
 * the contract's own. Binding to the current evidence candidate happens
 * downstream in the session source (`evidenceRevision === candidateRevision`
 * and `candidate === candidateDigest`), so stale entries linger harmlessly
 * without ever authorizing completion.
 *
 * Returns undefined when nothing new would be recorded.
 */
export function mergeServiceAttestations(
  contract: MissionContract,
  entries: ServiceAttestation[],
): MissionContract | undefined {
  const fresh = entries.filter(
    (entry) =>
      entry.missionId === contract.missionId &&
      entry.missionRevision === contract.missionRevision,
  );
  if (fresh.length === 0) return undefined;
  const existing = contract.independentVerifications ?? [];
  const byKey = new Map(
    existing.map((attestation) => [`${attestation.evidenceRevision}\n${attestation.candidate}`, attestation]),
  );
  for (const entry of fresh) {
    const key = `${entry.evidenceRevision}\n${entry.candidate}`;
    const mapped = {
      verifierId: "operator-control-service",
      missionRevision: entry.missionRevision,
      evidenceRevision: entry.evidenceRevision,
      candidate: entry.candidate,
      verificationResult: entry.result,
      receiptCorrelationId: entry.receiptCorrelationId,
      // Service records epoch seconds; the contract convention is epoch millis.
      verifiedAt: entry.verifiedAt * 1000,
    };
    const current = byKey.get(key);
    if (
      current !== undefined &&
      current.verifierId === mapped.verifierId &&
      current.missionRevision === mapped.missionRevision &&
      current.evidenceRevision === mapped.evidenceRevision &&
      current.candidate === mapped.candidate &&
      current.verificationResult === mapped.verificationResult &&
      current.receiptCorrelationId === mapped.receiptCorrelationId &&
      current.verifiedAt === mapped.verifiedAt
    ) {
      continue;
    }
    byKey.set(key, mapped);
  }
  const merged = [...byKey.values()].slice(-32);
  if (merged.length === existing.length && merged.every((attestation, index) => attestation === existing[index])) {
    return undefined;
  }
  return { ...contract, independentVerifications: merged };
}
