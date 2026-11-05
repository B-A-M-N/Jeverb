# Independent Jev Evaluation Labels

## Why this exists

The retained mission-closure labels were builder-authored and have no
independent adjudication record. The retained `prompt-routing-v1` labels
classify prompt intent; they do not describe consequential graph branches.
Neither corpus can serve as independently labeled qualification data. The
2026-11-03 model runs have already exposed Jev to their development cases, so
re-labeling those cases can audit old labels but cannot turn them into a fresh
sealed qualification split.

## Blind annotation workflow

Use `npm run bench:annotation -- prepare <source.jsonl> --packet <packet.json>
--key <private-key.json>` to create a randomized packet and a separate source
ID map. The source may contain unlabeled `{id,state,questions}` records or
existing labeled calibration records. The packet retains each model-visible
`state` and typed `questions`, but omits case IDs and all `expected` labels.
Both files are created read-only-once with mode `0600`; keep the key with the
evaluation steward and send annotators only the packet.

Two different qualified reviewers label every case independently. They must
not see the old labels, model responses, each other's annotations, or the key,
and they must not have authored the cases or policy. Each annotation JSONL row
has this shape:

```json
{"reviewerId":"reviewer-a","annotationId":"opaque-id-from-packet","answers":{"closure":{"choice":"INCOMPLETE","rationale":"A requested criterion has no verified outcome.","evidenceRefs":["state.acceptanceCriteria[1]"]}}}
```

Choice labels must exactly match a listed question criterion. Require a
written rationale and at least one cited state field or evidence reference.
Keep reviewer identity and a signed independence attestation in the study
record; the distinct `reviewerId` check only prevents accidental reuse of one
ID and cannot establish a person's independence.

Run reconciliation with the original source and packet/key, plus both rater
files:

```sh
npm run bench:annotation -- reconcile \
  --dataset <source.jsonl> --packet <packet.json> --key <private-key.json> \
  --rater-a <rater-a.jsonl> --rater-b <rater-b.jsonl> \
  --report <annotation-audit.json> --labeled-dataset <labels.jsonl>
```

The tool rejects incomplete, duplicate, malformed, unsupported, or source-
mismatched annotations. It emits no labeled dataset when the two reviewers
disagree. A third independent subject-matter adjudicator can resolve disputes
by supplying `--adjudicator <adjudicator.jsonl>` in the same format; the audit
retains both original judgments, the adjudicator's judgment, rationales, and
evidence references. Preserve the packet, source bytes, private key, all three
rater files where applicable, signed independence declarations, reconciliation
report, and resulting labeled dataset together, with hashes and identities in
the evaluation manifest.

## Closure cases

Each closure case must include the original objective, all acceptance criteria,
candidate revision, verifier outputs, relevant task results, pending or
uncertain operations, blockers, and any contradictory or stale evidence. The
four choices mean:

- `COMPLETE`: every objective criterion is supported by current independent
  verification; no required work or operation remains.
- `INCOMPLETE`: the objective is clear and at least one criterion or required
  operation remains unmet.
- `BLOCKED`: a named external dependency prevents otherwise understood work.
- `INSUFFICIENT_EVIDENCE`: evidence is missing, stale, contradictory, or too
  indirect to decide.

Raters cite concrete evidence paths for each answer. A `COMPLETE` label must
identify verifier evidence for every criterion. A `BLOCKED` label must name
the external dependency. Do not use a model judgment as a label source.

The existing release policy remains unchanged: at least 60 independently
labeled positive cases, 149 independently labeled non-COMPLETE cases, zero
false terminal completions, and at least 95% positive liveness. Group related
variants by mission domain before splitting; no domain or scenario family may
cross development, validation, and final sets. Use development for iteration,
validation once a candidate is fixed, and final only for a separately
authorized one-time release evaluation. Report both case-level and
domain-cluster uncertainty.

## Consequential graph-routing cases

Create a separate corpus from real runtime graph branch contracts. Every case
must show the objective, current node, typed branch question/options, proposed
transition, dependency and verification state, and the policy-authorized
alternatives. Keep authorization itself outside Jev's labeling responsibility:
the reference judgment identifies a semantically appropriate transition or
deferral; the deterministic authorizer still decides whether execution is
allowed. Labels must cover valid route, defer, reject, and insufficient
evidence cases, including adversarial branches with unsafe or unmet
dependencies. Each rationale cites the graph/policy fact that supports it.

The existing consequential-routing release floor remains at least 60 cases
and 90% judgment accuracy. Split by graph/scenario family, not by row. Report
per-class accuracy, deferrals, invalid/provider errors, and every proposed
protected action reaching deterministic authorization. No such independently
labeled route corpus currently exists, so routing qualification and model-
controlled protected graph execution remain unavailable.

## Qualification boundary

Independent annotation establishes a reference label set; it does not itself
qualify a model. Qualification also requires a frozen question/policy identity,
actual provider receipts, model and adapter identity, complete error/cost/
latency accounting, confidence intervals, required sample sizes, and the
existing deterministic authorization and verification gates. Historical
results stay immutable. Any question, evidence, or label-policy revision gets
a new version and evaluation identity.
