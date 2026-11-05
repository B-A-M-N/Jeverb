# Limitations and qualification status

Jeverb is experimental. Feature presence, unit tests, and successful local demonstrations are not equivalent to model or production qualification.

## Model quality

The available historical mission-completion measurement was 13/64 (20.31%) against a 95% liveness floor. Other small advisory results, including 8/8 on a straightforward classification set, answer different questions and do not overturn that result. Consequential routing and mission-completion reliability remain unqualified. The 2026-11-04 corrective loop is one successful development case, not a reliability sample.

## Authority and enforcement

Jev is advisory unless an exact decision family has valid independent qualification and the existing policy explicitly admits its use. Deterministic authorization remains separate. Production terminal completion remains disabled absent its required qualification. Host-wide enforcement depends on the root-owned control service, PolicyKit integration, and protected switch; local tests cannot establish that installation is active or correct.

## Host integration

Muse packaging and local stub tests demonstrate packaging contracts, not that a new Muse session has approved and loaded all capabilities. The installed host may require capability review and a restart/new session according to Muse's lifecycle. Gateway alias configuration and actual returned-model identity depend on the running gateway deployment.

## JIVE

JIVE support is **experimental and partial**. Jeverb implements selected DAG execution patterns behind its own authorization and runner. It does not claim full protocol/runtime compatibility, equivalent workspace artifact paths, imported conversation history, or production interoperability.

## Platform and confinement

Linux x86-64 with a functioning Bubblewrap environment is the verified graph-execution target. macOS and Windows graph execution are unverified. Containers, restricted user namespaces, and IPC configuration can prevent Bubblewrap tests from running; do not relax confinement to make them pass.

## Scope of semantic judgments

Jev evaluates bounded text/evidence through typed questions; it is not a code interpreter or independent verifier. Parsing/AST evidence establishes structure, not behavior. Tests and host-owned observations remain necessary for behavioral claims. Agent-generated claims and model confidence do not establish that an outcome occurred.
