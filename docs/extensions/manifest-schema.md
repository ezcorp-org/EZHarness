# Manifest reference

The default scaffold passes its manifest and handlers to `defineExtension` from `@ezcorp/sdk/v4`.

The release manifest is declarative data with `schemaVersion: 4`. The shared workspace scaffold defines it inline in `extension.ts`. A package can instead import manifest data or a worker-only `defineRuntimeManifest` module. The host never evaluates an executable configuration file; it validates the data returned by isolated discovery.

The authoritative definitions are [the contract package](../../packages/@ezcorp/extension-contract/src/index.ts) and its [wire schema](../../packages/@ezcorp/extension-contract/src/wire-schema.json). Use `validateManifest` from `@ezcorp/sdk/v4` or `@ezcorp/extension-contract`. Do not maintain another handwritten validator or manifest type.

## Core fields

| Field | Meaning |
|---|---|
| `schemaVersion` | Literal number `4`. |
| `name` | Stable extension name. The harness scaffold uses lowercase letters, digits, and hyphens. |
| `version` | Release version. Publishing cannot overwrite an existing version. |
| `description` | What the extension does. |
| `author` | Author metadata, including `name`. This is not runtime authority. |
| `permissions` | Requested capabilities. A declaration is not a grant. |
| `tools` | Tool names, descriptions, and input/output schemas. Implementations live in the worker. |
| `methods` | Additional runtime methods and their input/output schemas. |

Use the template returned by `extensions_describe` for a complete valid package. `extension.ts` is the default build entrypoint; build selection is separate from granting access. All discovered tools and methods must match the sealed declaration.

## Contributions

The contract also supports skills, agents, workflows, pages, entities, settings, secrets, events, schedules, loops, webhooks, attachments, and MCP. Use the current SDK registration helpers and contribution schemas. Do not embed host-callable function objects in manifest data.

Skill and agent packages still pass through the same isolated build and release checks. A scaffold label does not bypass verification. Pages and event handlers must be registered before discovery completes; registration cannot call host capabilities.

## Permissions

Request only the operations required by the feature. The host checks the declaration, human grant, current installation, caller rights, conversation scope, and any project binding.

| Capability | Boundary |
|---|---|
| `network` | Host-mediated HTTP destinations. |
| `networkTcp` | Exact native TCP endpoints; broader than HTTP origin policy. |
| `env` | Approved opaque credential access, not arbitrary host environment strings. |
| `secretRead` | Explicit raw native credential access for supported providers; requires separate human consent. |
| `storage` | Host-mediated extension storage, with user/conversation/global scope. |
| `filesystem` | Host-mediated virtual paths; no supplied host path grants access. |
| `eventSubscriptions` | Declared events, with current scoped grants checked at delivery. |
| Other host capabilities | Exact current contract and broker checks, including project-write proposals where required. |

Read [Security](security.md) before adding network, credentials, shell, child-agent, or project-write access. Do not copy broad permissions from another extension.

## Changes and review

Source, test, dependency, permission, and schema changes create a new immutable revision. Build it, inspect the verified release, and request fresh human approval. Changing a manifest on disk never updates an active installation directly.

First-party source changes also require regenerating and reviewing the source lock through `scripts/regenerate-manifest-lock.ts`. The lock identifies source; it does not replace runtime approval.

Legacy v2/v3 executable manifests are not an alternate active runtime. Import reviewed source into a v4 workspace and rebuild it. See [Imports](v4-imports.md) for supported migration paths and limits.

See [API reference](api-reference.md) for control tools and runtime calls.
