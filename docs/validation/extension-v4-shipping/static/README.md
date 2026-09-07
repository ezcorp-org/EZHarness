# Static validation receipt

Source tested: `9b541ff500b6e2df6626ed101ee84600432514da`.

Tools: Bun 1.3.14; Node v22.22.2.

| Check | Exit | Result |
| --- | ---: | --- |
| Focused extension-author component test | 0 | 1 file; 19 tests passed; 2 s |
| `bun run typecheck` | 0 | Backend, web, backend-test, and web-E2E typechecks passed; 29 s |
| `bun run lint` | 0 | 4,091 files checked; 98 existing warnings; 11 infos; 1 s |
| Extension runner `--probe` | 0 | Kernel controls verified; 1 s |

The CI-only runner installer is separately recorded in the browser receipt as exit 1 because it intentionally refuses this NixOS host. The runner probe verifies the installed host runner used by real-auth validation.
