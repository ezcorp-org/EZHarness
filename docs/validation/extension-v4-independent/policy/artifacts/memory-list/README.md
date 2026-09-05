# Conversation-derived memory list regression

Baseline commit: `b9992dc4525f74b48cb8744015d942bf2560e87c`

Baseline tree: `6786d82e31b69f7e6ed72cfe001b0090ab170911`

Runtime: Bun `1.3.14` (`0d9b296a`)

The test calls the production `GET /api/memories` handler against a disposable
PGlite database. It seeds a direct owner memory, a conversation-derived owner
memory, another user's memory, and an unattributed memory.

## Red reproduction

Command:

```sh
env PATH=/tmp/ez-extension-bun-1.3.14/bun-linux-x64:$PATH \
  flock --close /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/validation-heavy.lock \
  bun test src/__tests__/memory-list-derived-owner.integration.test.ts
```

Exit: `1`. The owner received the directly attributed row but not the row owned
through its conversation. The other-user and admin checks passed. Raw output:
`red.txt.gz`.

Pre-fix source SHA-256:

- `src/db/queries/memories.ts`: `50b740c7a4da9e1f87d1fbbd95f1c16cef8d9be6bb0595bce1cf2387141d5096`
- `src/extensions/memory-handler.ts`: `d92e1050eba0cf7f54f30dc2c7738c9aedf81beb326ace4ddadd7f4703f4b06f`

## Green verification

Command:

```sh
env PATH=/tmp/ez-extension-bun-1.3.14/bun-linux-x64:$PATH \
  flock --close /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/validation-heavy.lock \
  bun test ./src/__tests__/memory-list-derived-owner.integration.test.ts \
    ./src/extensions/__tests__/memory-handler.test.ts \
    ./src/__tests__/memory-injection-user-scope.test.ts
```

Exit: `0`. Result: 29 tests passed, 77 assertions, 0 failures. This verifies the
management handler, extension RPC ownership, and prompt-injection ownership.
Raw output: `combined-green.txt.gz`.

Post-fix source SHA-256:

- `src/db/queries/memories.ts`: `ce40e97e896051d9516acb381339e1129416e14c4c516b7275018669a73b2769`
- `src/extensions/memory-handler.ts`: `c29c92c3646d854a189f75639c827a19959906877075c5552babe254c993cb87`
- `src/__tests__/memory-list-derived-owner.integration.test.ts`: `7cd5a7b3f2b6a7b770a38353e41780b07ac7277eeb4c042f68526426c9f0919d`

Artifact SHA-256:

- `red.txt.gz`: `e4bda6ab93df540163905993adbae87b3faf99aa7554357ee42e1579cfcb5ac2`
- `combined-green.txt.gz`: `f03771fd09ecea8aaf60df4b2584abfc268f302179903bbd8846de75ba50f2b3`
