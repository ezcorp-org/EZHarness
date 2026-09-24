# MVP sandbox provider wire contract

Status: C02 contract foundation. This document specifies wire data. It does not register a provider or grant runtime authority.

The public contract exports `providerMethodSchemas`, `validateProviderMethodValue`, and `validateProviderMethodExchange`. The schema factory extracts only the transitive definitions for one method from the generated authoritative wire schema. Provider manifests must use these exact input and output schemas. Authors must use the v4 `defineExtension` path so method metadata, including sensitivity and canonical schemas, is preserved.

All calls contain a `ProviderCall` with project ID, provider binding ID, generation, operation ID, idempotency key, and SHA-256 request digest. Feature indexing stays outside this provider contract. The MVP assigns one dedicated project to a feature. Provider results return the same operation ID, idempotency key, and digest in a `ProviderReceipt`. The host rejects mismatches.

Receipts report `succeeded`, `failed`, or `unknown`. A failed receipt requires a bounded error. A successful receipt cannot contain one. `unknown` preserves uncertainty; it does not authorize blind retry.

## Methods

| Group | Operations |
| --- | --- |
| `sandbox.lifecycle.v1` | `create`, `inspect`, `start`, `stop`, `destroy` |
| `sandbox.process.v1` | `start`, `inspect`, `readOutput`, `cancel` |
| `sandbox.files.v1` | `stat`, `list`, `read`, `write`, `mkdir`, `remove`, `chmod` |

Lifecycle resources use opaque IDs, desired and observed state, and exact integer limits: bytes for memory and disk, milliCPU for CPU, and a PID count. No floating point or ambiguous CPU unit is accepted.

Processes use an opaque boot ID plus process ID. They never expose or trust a raw operating-system PID. Start specifies bounded argv, environment, virtual working directory, workspace user, and `timeoutMs`: an execution duration of at most 24 hours measured from process start. Output uses a non-negative cursor, explicit gap and EOF flags, separate stdout/stderr chunks, and UTF-8 or canonical base64.

Files use `/` as the virtual workspace root. Paths are absolute within that virtual root, have canonical segments, and reject traversal, control characters, backslashes, unsafe JSON object keys, and trailing separators. Reads are revision-bound when requested and use byte offsets and lengths. Writes use an optional expected revision. List pages contain at most 256 entries. Modes are integer Unix permission bits from `0000` through `0777`.

One file or output transfer is at most 256 KiB decoded. The frame remains subject to the existing 1 MiB contract limit. Large transfer, streaming, PTY, resize, snapshot, suspend, Compose, and external secret delivery are outside the MVP.

Provider connection configuration is not sent in lifecycle calls. It belongs to the reviewed host-side connection revision in the later registration gate.
