# Decision: isolate factory tenants and mediate all external effects

**Date:** 2026-09-12, amended 2026-09-13 · **Status:** Accepted · **Area:** factory platform
**Code:** planned; no factory implementation exists; reuses `src/extensions/v4/` and `packages/@ezcorp/extension-runner` on main · **Feature:** [factory plan](../plans/2026-09-12-composable-factory-platform.md)

## Context

The platform must preserve current workflows while supporting 100 tenants, untrusted packages, long waits, and controlled release. Existing users have instance roles, and project listing is deliberately instance-wide. The native harness uses Bun. Temporal owns factory orchestration in a separate Node.js process. Commit #246 on main shipped an extension v4 lifecycle with rootless Podman isolation that is probe-enforced and fails closed, digest-bound single-use release approvals, a GitHub pull-request broker, a credential broker, a transactional outbox, and fenced locks; the first version of this record was written against a fix-branch commit that predated it. The current base still has two verified holes that bear on the decision: the shell tool and MCP's degraded tier fail open, and session tokens carry no audience claim. The master key file also lands in the process working directory on external PostgreSQL.

## Analysis

A shared harness installation with tenant filters would require changes across legacy project, provider, extension, and credential access. A tenant-per-installation model preserves these boundaries and allows legacy workflows to remain unchanged inside each tenant. It costs more processes, database connections, and deployment management. No capacity or cost benchmark has been run; the load gate must include those costs.

Directly importing the harness into the Temporal process would join incompatible runtime assumptions and privilege boundaries. Moving package execution into an isolated worker without isolating package preparation would still allow install hooks to reach control-plane credentials.

Exactly-once external effects cannot be inferred from durable scheduling. A stable operation journal and release broker provide a place to enforce current authority and reconcile uncertain outcomes. An external service can still leave an operation uncertain.

## Decision

Use one isolated harness installation and product database per tenant, with one authenticated Temporal namespace per tenant. Keep the graph interpreter trusted and package-free. Use an authenticated execution gateway to reach isolated Bun and Python runners. Run runners under the rootless Podman profile that the extension v4 lifecycle already ships and probe-enforces; use the same runtime with CDI device injection on dedicated tenant GPU hosts with a tested driver pair, with gVisor `nvproxy` as the recorded alternative for the GPU profile only. Route provider access and all publication through host-owned brokers that extend the v4 credential and pull-request brokers. Reuse the v4 approvals, outbox, locks, blob store, and transactional audit helper as C13 specifies; a parallel implementation is rejected in review.

Amended 2026-09-13: the original text selected gVisor for CPU execution before the v4 runner was known to exist. Replacing a shipped, tested runtime with a second one was not justified; the cost of the change is that the GPU profile now depends on Podman device injection meeting the F05 gate.

Keep Temporal as the execution authority. Store operation journals, product facts, and a durable execution audit feed outside disposable query projections. Archive release identities before dispatch. Restore starts with release disabled until recorded operations and external receipts are reconciled.

The [launch contracts](../plans/2026-09-12-composable-factory-platform-contracts.md) are the sole source for protocols, limits, roles, and tests. The existing plan records the Temporal engine choice and its alternatives; this decision does not add a second engine.

## Consequences

- Current instance-global behavior remains inside a tenant boundary. Factory project rights are explicit within that boundary.
- Tenant isolation, sandbox setup, and the Node/Bun bridge are mandatory work in stage 2, before real agent execution.
- Each tenant adds a harness service and database pool. GPU hosts are not shared across tenants. Load and cost evidence must include this footprint.
- A failed or unreachable worker can reduce available capacity until it is fenced or reconciled. Safety takes precedence over speculative capacity reuse.
- The release archive and backup checkpoints add storage and operational work. A stale recovery checkpoint can stop new effect dispatch.
- An operator with infrastructure root access remains part of the trusted computing base. Product APIs do not turn that role into user consent.
- A factory-enabled deployment is multi-service. The single-container, embedded-database deployment stated as a product goal remains the default only for installations that do not enable factories; the root CLAUDE.md goal wording is scoped to say so in stage 6.
- The two seams that still fail open on main (shell tool, MCP degraded tier) run fail-closed in factory-enabled deployments. A host that cannot jail does not enable factories. Installations without factories keep today's behavior. Extension code already runs under the fail-closed v4 runner everywhere.
- Of the C05 base-hardening items, the reserved-path deny set and the env-leak classifier are fixed for every installation; the fail-closed seams apply to factory-enabled deployments only; two items were already closed on main by the v4 lifecycle.
- Hosted operation needs a control plane that does not exist today (C12). Kubernetes artifacts, the Node.js and Python toolchains, an S3 object store, key management, the pool admission service, a metrics endpoint, and an outbound notification channel are all new.

## When to reconsider

Reconsider tenant-per-installation if the stage 6 workload cannot meet the required service targets within the recorded resource envelope. A replacement needs a separate design for every legacy data/credential boundary and the same cross-tenant tests. It is not a configuration shortcut.

Reconsider the isolation runtime when a required package cannot run under the supported profile or its security assumptions change. Change the versioned worker profile and rerun isolation, recovery, and domain proofs; never fall back to advisory execution.

Reconsider Temporal if the real-runtime continuation, recovery, or upgrade gates fail after correcting the adapter. Route new runs through a separately validated adapter; do not migrate active histories by assumption.
