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
`red.txt`.

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
Raw output: `combined-green.txt`.

Post-fix source SHA-256:

- `src/db/queries/memories.ts`: `ce40e97e896051d9516acb381339e1129416e14c4c516b7275018669a73b2769`
- `src/extensions/memory-handler.ts`: `c29c92c3646d854a189f75639c827a19959906877075c5552babe254c993cb87`
- `src/__tests__/memory-list-derived-owner.integration.test.ts`: `7cd5a7b3f2b6a7b770a38353e41780b07ac7277eeb4c042f68526426c9f0919d`

Artifact SHA-256:

- `red.txt`: `9f55be19822e6a954c19688881e10371c521c174a08ac40d2a1eb6d071e418b1`
- `combined-green.txt`: `90dcf4cb8d8dcda89ee16ceab65cde4159df3e85953d4aa78a4f60b38a4ff953`
