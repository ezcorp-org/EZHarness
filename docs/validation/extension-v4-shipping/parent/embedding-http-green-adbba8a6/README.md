# Production HTTP embedding receipt: adbba8a6

This is a green, bounded production-memory embedding check for candidate `localhost/ezcorp-extension-v4:shipping-adbba8a6` and source `adbba8a693cdcd4410c51023dfca93517f9db1e8`. It is not the complete candidate eight-suite result.

## Result

The outer verifier exit is `0`. The owned runtime command, app-log collection, and cleanup each exited `0`; `runtime/command.log` also records successful setup and key creation. The verifier created a memory through authenticated HTTP, polled its stored vector and then asserted database-up and embedding-ready health. It recorded384 finite values with unit norm `1.0000000045689894`, after33polls and8242ms.

`runtime/compose.log` records the expected startup warning that the embed worker is not ready before the cold model becomes ready. The successful HTTP result follows that warm-up condition. No `InferenceSession` error appears in the retained logs.

## Contents

The receipt retains the outer verifier result, source SHA, verifier hashes, native image inspection, and the owned runtime command, provenance, verification, and compose logs. It excludes authentication material, session files, and image blobs.
