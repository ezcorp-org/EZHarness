# Hosted static and policy checks at 0733ca51

CI run 34164945893 tests head `0733ca51daf570227bd801b14991700ad0ca0c12`.
All four typecheck sections, lint, Svelte and manifest lock checks pass.
Lint checks 4,428 files with no errors; Svelte retains 13 warnings in five files and no errors.
Actual job logs are copied unchanged as inert text and mapped by bytes and SHA-256.

Gate integrity fails with 83 findings. The same ordered finding identities remain.
One finding has updated counts: `extensions-api.test.ts` removes 189 assertion/test lines and adds 48, compared with the earlier 188/45. The net reduction against main improves from 143 to 141. Parent compares the actual ordered output and retains that precise change; the list is not byte-identical to the prior checkpoint. No policy label or exception is applied.
