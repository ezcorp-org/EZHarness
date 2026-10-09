# Incus memory observation comparison — 6 October 2026

The current app qualification failed. Two matched backend diagnostics support
helper observation timing as a contributor to the delay. They do not prove a
unique cause, complete resource isolation, healthy services, or qualification.

## Fixed conditions

Both diagnostics used the approved image `ebe5ce977a726130fd1aa90d2c853467bb6d143141ed07f74b7a06e98efd3912`,
helper `804d68bd8d83ca817c6413eb3b2365216778aa26421c81fb3e9f3810b82dcb75`,
and unchanged load script `27f1cc10d8a971c51fc5e5b9879a46990bab44b781b0b4d305677b04d2e26e50`.
Each guest had 4 GiB memory, zero swap, two CPUs, 1,024 PIDs and a 20 GiB disk.
Each process had one START and the same 110-second deadline. Observations used
the saved process and boot IDs. A host collector recorded the enclosing cgroup.

These were operator-owned guests accessed through the server's Incus CLI.
They did not use the app broker, extension worker or its TLS/WebSocket path.
The only intended behavior difference was the observation start time. Each run
had its own resource IDs and evidence directory.

## Results

| Evidence | B: first observation after 70 seconds | C: immediate observation |
| --- | --- | --- |
| First output request | +70.030 seconds | +0.207 seconds |
| Target memory kill | About +2.6 seconds | +130.638 seconds |
| Original deadline | 110 seconds | 110 seconds |
| Diagnostic result | Terminal output and exit 0 at +70.354 seconds | Deadline failed; late reply refused |
| Other killed service | Docker daemon also killed | No Docker victim in the bounded kernel window |
| Cleanup | Original stop and delete succeeded | Original stop and delete succeeded |

C's target kill occurred 20.638 seconds after the deadline and 14.638 seconds
before the recorded cleanup STOP. The cleanup STOP therefore did not trigger
that recorded kill. No deadline was extended and no process START was repeated.

Independent review checked all 70 files in B's evidence index and all 80 files
in C's index. Original native operation receipts, actual stopped states, and
instance and volume absence were checked. Fresh scoped and whole-project
inventories were empty after each cleanup.

| Local evidence | SHA-256 |
| --- | --- |
| B evidence index | `19e5519f33798d7d1a921f02a3e0bd22c324c50148ffb3569cb88ae21f648492` |
| B diagnostic result | `e2a3900ad9956a81752dab33c45f9dc42470811b8770b3cafbb0facfe44d7b7c` |
| B kernel window | `c140197cc98816b2be16ccbaeceb426de079511591c8c2317a2480d1c64f2ff9` |
| C evidence index | `6e00ac4e3e84dfb9a64f7c414527294b9ea8b2faf5e3a8bc5edc91e434826d9d` |
| C failed memory phase | `12f9decdd673851e9fa016f2edfd54f3aa98fc67b3a44c0e3c102a657e56d5f7` |
| C kernel window | `defa5b2b62b5220d3d1e7cad928a032819d3661381d93841b3f7d065ce323204` |
| C cleanup result | `02a6da5d3332ac524c6e7b30a2a6cf5111cf7c4fe339b3525517f76ac84dae4a` |

Raw evidence is retained in the sole live operator worktree under
`.cache/diagnostic-B/` and `.cache/diagnostic-C/`. Sensitive raw records are not
published in the repository.

## Fix boundary

Do not replace guest-user observations with unrestricted privileged Incus file
reads. The helper state has guest-writable parent directories; a changed parent
link can redirect a privileged read. Checking metadata after the read cannot
undo that disclosure.

The tested candidate uses the unchanged helper as the same guest user through
`/usr/bin/python3 -I -S`. This avoids Python site startup and untrusted import
paths. Its matched diagnostic D retained the same immediate observation
schedule, load, resource limits and deadline as C. Before the load, the live
guest confirmed Python 3.11.2, isolated mode and disabled site startup under
UID/GID 1000. The unchanged helper completed its protocol readiness check.

D returned complete output, EOF and exit 0 at +3.182 seconds. The load child
was killed at +2.545 seconds; its OOM delta was one. The bounded kernel window
showed no Docker daemon victim. The original stop and delete operations
succeeded, the instance and volume were absent, and the fresh whole-project
and scoped inventories were empty. The collector completed its original bound.

Independent review checked all 82 files, interpreter and process identities,
original operation receipts, kernel timing, cleanup and empty inventories.

| D evidence | SHA-256 |
| --- | --- |
| Evidence index, 82 files | `b10915f6085660a6cea18f419724eb2f8763c093e6269ab4ef75f99548571ccb` |
| Memory result | `bc7a4c20c838902df599deb7bbee1fbfc7b05cbd49623f7f850688824bfcbd08` |
| Local memory phase | `90447f208557fcd04362f6a7bd436f72afe2e2baec9f3fb5d886f15e6fa5291c` |
| Kernel window | `4444bf37c18a43a5fc91bb2d0faebec5581c3a2b9b7cafb515d56a31ae84f94d` |

The host transport regression failed against the old helper invocation and
passed with the candidate. All 12 transport tests passed, including the real
helper over the pinned TLS/WebSocket connection. The implementation changes
only the host invocation; helper bytes, image, provider release, guest user,
polling schedule and process deadline remain unchanged.

This diagnostic supports testing the candidate through the app. It does not
establish general performance reliability, qualification, or A05. A fresh app
qualification, native workflow and repeated lifecycle tests remain required.
