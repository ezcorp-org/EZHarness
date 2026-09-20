# Pluggable infrastructure execution contract

Source: docs/plans/2026-09-20-pluggable-infrastructure-tasks.md. All required R1–R3 outcomes remain in scope. Optional R4 selection is pending user input.

## Shared rules

Use the existing v4 contract, schema generator, approval engine, broker and test selectors. No local fallback for sandbox-required projects. No secret bytes in normal outputs. No support claims from mocks. Preserve current local behavior. Interfaces are frozen per work package before implementation delegation.

## Ownership and sequence

1. Parent: source baseline, integrated plan, gap decisions, integration and evidence.
2. Sol: independent contract/security audit in ../pluggable-sol; later assigned bounded implementation leaves.
3. Terra: independent runtime/test audit in ../pluggable-terra; later assigned bounded implementation leaves.
4. Contract and runtime foundations precede durable control and adapters. UI follows stable production APIs.
5. Parent reruns agent checks and inspects integration. Heavy checks use /tmp/ezcorp-validation-heavy.lock.

## Acceptance gates

gates/pluggable-root.md tracks review, repository implementation, verification and live acceptance. tasks/todo.md retains every backlog item. No task is closed merely because a subset passes.

## Status

- 2026-09-20: Fetched origin/main and created three worktrees. Sol and Terra reviews running. Requested test connection locations, original PRD and optional scope.

- 2026-09-20 user scope correction: no AMD/Xeon, Incus or Infisical deployment exists. Build and validate locally first. External-host networking and deployment follow after local proof. Preserve the eventual R1–R3 backlog, but local completion requires real locally available runtimes and explicit unsupported capabilities.

- 2026-09-20: User removed Claude/Codex guest workers (N01/N02). Native EZHarness only. Other R4 choices under discussion.

## First implementation leaves

| Leaf | Owner | Files | Proof |
| --- | --- | --- | --- |
| Provider contributions | Sol contract | extension-contract package; SDK type exports | Shared schema parity, invalid declarations, full changed-line coverage, build |
| Workspace routing | Terra runtime | runtime/workspace, tools factory, setup, DB binding migration | Persisted target, seven tools, no local fallback, stale target denial |
| Sensitive dispatch denial | Terra boundary | release-process and own tests | Sensitive calls never start ordinary worker; controlled boundary fault fails |
| Local runtime qualification | Sol infrastructure | scripts/pluggable-infrastructure and own docs/tests | Actual bounded temporary runtime, recovery, cleanup, honest unsupported controls |

Parent owns integration, shared coverage registration and final verification. Agents commit isolated changes; parent reviews and reruns checks. No first-wave result closes the full local milestone by itself.

## Active MVP scope

User selected the bare minimum local MVP. This supersedes the initial R1–R3 implementation scope. See the final scope section in the source backlog. Contract and routing foundations remain; optional protocols, Infisical, second-provider proof, external networking and full Compose qualification are deferred.
