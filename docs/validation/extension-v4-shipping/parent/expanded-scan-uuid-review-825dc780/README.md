# Expanded archive scan review

The first complete expansion and scan exits 1 with exactly two matches. Both are the same historical coverage log row: `tokenActorExtensionId` contains the UUID of a test extension. Source `src/extensions/tool-executor/provenance.ts` records the actor extension ID from the resolved call context; the adjacent test asserts that a call issued for another extension is rejected. It is not a login credential. The safe review records paths, member hashes, field names, and classification without the UUID.

All 15,943 expanded members, including 3,100 copied hardlinks, entered the scan. Aggregate expanded bytes are 7,445,289,388. Original source and index identities, actual exits, and UTC times are retained. This is a failed scan with reviewed findings; the subsequent sanitized publication must pass separately. No scanner exception is added.
