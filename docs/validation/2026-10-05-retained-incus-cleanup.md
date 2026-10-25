# Retained Incus guest cleanup — 5 October 2026

Status: **cleanup complete**, including EZHarness accounting.
The first saved delete returned `OUTCOME_UNKNOWN`. A targeted operator cleanup
then removed the stale instance. No new EZHarness delete was admitted.

## Target and preserved history

- Guest: `ezh-a51a9153641e7cb3d3d7880a9c64c4d3` in project `ezharness`.
- Cleanup: `8157dc85-d05a-4bb2-9550-726a0a7c2bbb`, admitted once.
- Original operation: `069a01c0-83e0-42ca-9efa-8e8e65b4340f`, still
  `OUTCOME_UNKNOWN`.
- Provider operation: `incus-destroy-013023cd-2e8b-4d63-881f-171fee1ef401`.
- Installed isolated app: `3fe533583bb71e4db339da80476cf39d27064086`.

## Verified recovery

The current AMD configuration had omitted the isolated service accounts and
units. The reviewed candidate restored them while preserving the running
baseline. Its first switch returned nonzero. A separate guarded check proved
the actual system, boot selection, accounts, units, storage and access state
before stopping the rollback timer. The original switch failure remains in
the record.

The complete signed restoration fixture passed against a copied database.
It preserved six table snapshots. This fixture did not exercise real backend
effects. Its result SHA-256 is
`7a8d24cc8f69caf5455a6982c9891b7ec41cc4a676802222e53d4e53016cd7c0`.

The subsequent live restoration ran once and passed. It restored transport
and archived the original hold without changing its bytes. The normal
isolated supervisor then started once to process the existing cleanup.

| Receipt | SHA-256 |
| --- | --- |
| Live restoration result | `57835acde04fc527454a6bdc3cdf9cd00cfbd1df5fffa7d5ec8d11d690848cb0` |
| Restoration receipt | `0412b988e52111e498a684214101655a0b557b528cc130f652575285ee108527` |
| Complete restoration proof | `70cc26a88cdf31c280c18133fd3fd028f9fd09502876e9590664409cab83d7a8` |
| Archived original hold | `9141f512842d97549959a6c28dea7b2220cdecbc4f53f62b04480329e14db987` |

## Cleanup result and safe stop

Authenticated status returned HTTP 200 and reported the saved delete as
`OUTCOME_UNKNOWN`, with desired state ABSENT and observed state STOPPED.
Its receipt SHA-256 is
`658ff7a12c233693cfa10e99e48df223081a8f7735f6966dfac1c530b80cf3d4`.
Independent inspection found the guest stopped with a destroy intent tag.
The saved provider operation returned not found. Neither result proves that
the guest was removed.

The isolated actors were stopped before copying the database. The copied
database audit confirmed both reservations still RESERVED and the original
operation unchanged. Audit SHA-256:
`28272765ab3232a6de295d7b042978081c100335484c9e91fcae764ca55ffbfe`.
The live database was not opened by a second process.

Next: classify the saved native receipt, then use a supported recovery path.
Do not infer that the delete was issued from the provider operation prefix:
the adapter can also use that prefix for a failed asynchronous intent update.

The Incus daemon logged a target-specific Btrfs warning at 03:58:28 UTC:
it could not make the instance subvolume writable because the subvolume flag
query returned `Invalid argument`. The saved log SHA-256 is
`bb2e7be55c44ae29a099cf39e85f056c619781f5e6a6544e2d558d0e1101820e`.
This is a diagnostic lead, not proof of which API operation failed. Incus's
[Btrfs documentation](https://linuxcontainers.org/incus/docs/main/reference/storage_btrfs/)
states that the driver uses a subvolume per instance. The exact target's
subvolume and mount state were then checked in the Incus daemon's mount
namespace: the pool is writable Btrfs, but the target is an ordinary directory,
not a subvolume. It contains only `backup.yaml`; no root filesystem remains.
The target is not a symlink. The matching Incus volume is used only by this
instance. Metadata receipts:

- Subvolume check: `9c90c10bfef645f883721f440e4bbd0424745e9eaf5681aa771e4f52bb0fb783`.
- Directory check: `71b6b0c1e73f7afade2e55eb39e848384d7a1ff2fa4a4674c26f7d4623ea8d63`.

The narrow repair preserved the exact metadata directory by an exclusive
rename, then used one normal Incus delete to remove stale records.
No empty subvolume or replacement guest was created.
The existing EZHarness read-only reconciliation can settle the saved delete
from fresh scoped absence, even if the native operation has expired; that
does not establish which actor removed the guest.

Reviewed script SHA-256:
`ceb93828de0ed031937d5b26328705cc1c54f004062861ea5007f0cad181a39a`.
Four focused tests and the live read-only preflight passed. The one execution
preserved the metadata and returned exit zero from Incus delete, followed by
structured instance-not-found confirmation. The script's final combined
operation-list/path check returned nonzero; this result remains recorded at
`1bf498c1293f9f24c0d7dd46363f8d57348683f344c8e055012efb201aa784ef`.
The cleanup script was not repeated.

A separate fresh read-only check then proved instance absence, an empty
operation list, absence of the original storage path, and unchanged metadata
in quarantine. Its SHA-256 is
`bcc078eb77d31fb7e9460d1a6e922747690647f9cef4f2a57fd184f286136495`.
The initial final-check failure may have been a briefly retained completed
operation; that cause was not captured and is not asserted as fact.

The preserved metadata is 4,998 bytes under
`/var/lib/incus/storage-pools/ezharness-btrfs/ezh-orphan-8157-metadata` on the
sandbox server. It is private audit evidence, not a retained guest rootfs.

## Final accounting and service state

Normal read-only reconciliation settled the existing cleanup as SUCCEEDED.
The final audit ran against a copy made only after stopping the isolated
actors and verifying no database handles remained. It confirms:

- Binding desired state and observed state are both ABSENT.
- `cleanupConfirmedAt` is `2026-10-05T04:23:09.145Z`.
- Compute and disk reservations are both RELEASED.
- Original START `069a01c0…` remains OUTCOME_UNKNOWN with its recorded fields
  unchanged. Its earlier uncertainty was not rewritten as success.
- The signed recovery link still points to the same cleanup; no new EZHarness
  operation was admitted for the operator repair.

Final accounting receipt SHA-256:
`593625db726bd50b9ef75f88100a2d4deee5f71771fdfbd779da9a4c61dc7a7f`.
The isolated supervisor and runner are stopped with no main PID. The retained
test session was revoked, and using the unchanged old cookie returned 401.
Session revocation receipt SHA-256:
`e630d1fb717d358e47d42cfc39b0fd2149a380c80f7a2a6b13971a6a80e0991a`.

Final normal-state checks confirm normal sandbox-server generation, SSH access,
the exact scoped client trust, and no remaining recovery rollback units.
The AMD host remains on the verified restored generation. Receipt SHA-256:
`d4aff16df08d347e2ef78b2b1d20a9548f8a6dad865d284fb017ddfe2cb093e8`.
The final paused-state receipt confirms all three isolated units inactive,
no process under the four qualification identities, no database handles, and
the original live database identity unchanged. Its SHA-256 is
`e4a8a8b1f954fa56ee63fba2b987b87950aa3951fee44ad835b3439317ebba42`.
The isolated ingress restriction remains in place.

## Source validation and limits

The full local gate passed on
`ddbada2834851724bce8fd26cb4952fa044e391a`, including 28,323 backend coverage
tests with zero failures, browser suites, and new-file and patch coverage.
That source was pushed to PR 303; all 51 hosted checks passed. The installed
app remains the earlier revision stated above.

Follow-up `711cfa6bf` adds DESTROY intent failure and cancellation regression
tests. The lifecycle file passed 43 tests with 638 assertions. The full fast
gate then passed with exit zero: 27,519 backend/example tests, 3,638 web unit
tests, 7,724 component tests, lint, type checks, Svelte checks and production
build. Log: `.cache/incus-cleanup-711cfa6bf-fast.log`. The fast gate does not
rerun coverage or gated E2E; the full-gate result above belongs to `ddbada283`.

Cleanup is proved. It required a targeted operator repair and does not prove
that ordinary provisioning and deletion work without intervention. A complete
live feature workflow, portability, and readiness of every sandbox integration
remain separate release gates.
