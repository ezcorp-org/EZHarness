# Temporary access for the preserved Incus START

Status: reviewed, awaiting approval. No key, timer or server fence has been
installed by this plan.

## Reason

The isolated app is running verified source
`5080f3792dbbedcdae17b81368ed9ee83ba41b80`. Its preserved START
`c7b5f35d-aa75-421f-aa6b-0741840c8c39` remains UNKNOWN. The exact guest is
`ezh-e527e87eb409d89f6e70d58c8ea4a49b`, stopped at backend generation 2.

Recovery must freeze the server's normal operator user. The working operator
SSH session uses that same user slice. The old root recovery key is absent,
so normal passwordless sudo cannot provide access while that user is frozen.

## Exact scope

- Server: `sandbox-server.taile1c5b0.ts.net`.
- Add one temporary root SSH authorization entry, restricted to AMD source
  IPv4 `100.77.117.56` and a closed forced-command dispatcher, at
  `/etc/ssh/authorized_keys.d/root`.
- Reuse the existing key with fingerprint
  `SHA256:9+VVbYWAy12Hgxm15QREVbvUysmBz84tsMqHK0g0rjU`.
- Permit only the pinned lease, fence, observation and restoration operations
  for this exact c7 recovery. No general shell or arbitrary command is allowed.
  SSH lease commands are `c7-lease probe`, `freeze`, `verify` and `thaw`;
  adapter actions are `verify`, `restore`, `observe`, `fence` and `fence-state`,
  accepted only through the exact pinned transport command format.
- Maximum access lifetime: 600 seconds on the same server boot. Derive the
  absolute deadline only when the approved plan starts; never extend it.
- Use the route only for the existing reviewed fenced-cleanup path. Preserve
  the original START as UNKNOWN and record cleanup as a separate operation.
- Remove the exact temporary key entry and restore the previous key-file
  absence. If its contents have changed, preserve them and report the conflict.

This changes root SSH authorization temporarily. It does not create an account,
activate a NixOS generation, change networking, or activate a provider release.

## Execution and failure checks

1. Verify all pinned files, source, manifest, current target and prior key-file
   absence. Reject drift or an existing attempt marker.
2. Arm an independent root systemd expiry service and timer. Its first command
   thaws `user-1000.slice` before Python cleanup can run.
3. Verify the actual loaded unit, exact commands, same-boot deadline and
   required time margin. Only then install the one temporary key entry.
4. Prove the restricted route works before freezing any user. Use the existing
   fenced recovery checks and exact target evidence; do not replay START.
   Fence only certificate
   `fcd2d46c8f4007cd01098123e6bfbfba0c962b1c9d9f511bf222dfb7a9b3e622`
   for project `ezharness`. Submit one operator request, validate its signed
   evidence, and admit one compensating DESTROY through the existing broker.
5. Restore access and credentials through the reviewed restoration path.
   Remove the temporary authorization after its use. The independent timer
   thaws the user and attempts exact-key removal if the caller fails.
6. Preserve uncertainty and holds after a possible admitted effect. Do not
   restore the database or repeat an uncertain operation.

A reboot clears the transient freeze and timer. The forced dispatcher rejects
a different boot or an expired deadline; any remaining exact key then requires
verified operator removal. The armed runtime pins receive a final independent
review before signing or admission. This is a guard within the approved plan,
not a request for another approval of the same work.

## Sealed evidence

The root-owned packet is
`/root/ezh-qualification-stage/oct05-c7-start-recovery-access-prepared`.
Its directory is mode 0700 and files are mode 0600. The index pins every
included file; the preview is deliberately non-executable with deadline 1.

| Item | SHA-256 |
| --- | --- |
| Packet index | `bc1c6aaf20b3c5f787c8407f620db6f2ad5f2c184df93cfb30e3c51afe9cb343` |
| Preview pins | `acebe540720d7af42eb88870b27bf4c38eeb44d785113853b68ce433acc3fdbc` |
| Policy | `bb08ec57ed15874aa1044d420ed66549294d39182be8bc26864c2604abb439f4` |
| Dispatcher | `673270c440cabd2441107d06c64e5ee311ac4f1bab11d4f43cab966278b5ce0a` |
| Expiry helper | `3024bfa692d567f18e055ca69397384cf9f9cc8857c351034c0b75ba64ffc5db` |
| Key installer | `07307afcbb22819c85b1cc78ac073c7c9a3b28b1aeb242ecbc045c6f401dd444` |
| Exact temporary key entry | `f9d4be853fc10fbdd71674fa8c9acc884ac112006fbb5c3f0006c1c0ea3b4218` |
| Installed app manifest | `f935dbb456db40581cf1642f1f6bd2049e28062f605298ea395dff0195191748` |

Twenty helper tests, six installer tests, compile checks and independent code
and sealed-packet review passed. Actual timer and route checks remain guarded execution steps;
local tests do not establish that they have run on the server.
