# Factory graph proof: deterministic tasks and a model task, end to end

This runbook runs one factory graph on a real started application. Two task
nodes run plain code. One task node calls a language model through the broker.
Each node's output feeds the next node. Follow the steps in order. Each command
is exact.

## What the graph is

The graph has three task nodes. Every wired value is a reference to a port.
No node reads a literal for a value that another node produced.

| Node | Runs | Reads | Writes |
| --- | --- | --- | --- |
| `prepare` | plain code | the run's `topic` input | `text`, `count` |
| `infer` | one model call through the broker | `prepare.text` | `answer`, `usage` |
| `combine` | plain code | `prepare.count`, `infer.answer` | `summary` |

The graph's output `summary` is `combine.summary`. The guest code for all three
nodes is `scripts/factory-graph-proof/guest/graph-guest.ts`. The definition is
`graphDefinition` in `scripts/factory-graph-proof/graph.ts`.

The proof has two modes. They run the same guests and the same graph. Only the
model pin of `infer` changes.

| Mode | Provider | Model | Needs |
| --- | --- | --- | --- |
| `ollama` | `ollama` | `qwen3:1.7b` | the host's Ollama at `http://127.0.0.1:11434` |
| `mock` | `ezcorp-mock` | `prompt-digest:w19a` | nothing; the fake runs inside the product |

Both modes pin temperature 0, seed 42, and reasoning effort `none`. Ollama
honours all three. With reasoning effort `none`, `qwen3:1.7b` gave the same
answer on repeated calls. Without it, the reasoning text changed between two
identical seeded calls. The mock ignores the three settings. It returns a fixed
answer for each prompt digest.

## Before you start

1. Use the pinned toolchain.

   ```sh
   export PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH
   bun --version    # 1.3.14
   node --version   # v24.14.1
   ```

2. Install dependencies in the worktree, if you have not already.

   ```sh
   bun install --frozen-lockfile
   (cd web && bun install --frozen-lockfile)
   ```

3. Make sure the shared stores are up. These commands only read.

   ```sh
   podman ps --filter name=factory --format '{{.Names}} {{.Status}}'
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18333/
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18334/
   ```

   You must see `factory-platform-proof-postgres` and both storage services
   up. Each `curl` must print an HTTP status (403 is healthy). Do not restart or
   reconfigure a shared store yourself. Report a dead store to the coordinator.

4. For mode `ollama`, make sure Ollama serves the model.

   ```sh
   curl -s http://127.0.0.1:11434/api/version
   curl -s http://127.0.0.1:11434/v1/models | grep -o '"qwen3:1.7b"'
   ```

5. Export the storage credential directory. The path changes on every reboot,
   so read it from your session. Never copy the files anywhere else.

   ```sh
   export EZCORP_FACTORY_STORAGE_SECRETS_DIR=/run/user/1001/ezcorp-factory-storage.<suffix>
   ```

   The script reads the PostgreSQL user, password and database from
   `/tmp/factory-platform-evidence/postgres.env`. It builds the URL inside the
   script and never puts it on a command line.

## Run the whole proof

This builds the web server from the worktree. Then it runs three passes in
mode `ollama`, three passes in mode `mock`, the two negative controls, and the
summary. Every pass boots a fresh installation on new, empty pool and product
databases. The command holds the shared heavy lock, with the timeout inside
the lock.

```sh
flock --close /tmp/ezcorp-validation-heavy.lock timeout 5400 scripts/factory-graph-proof/run.sh all
```

The exit code is 0 only when every pass, every control, and every cross-pass
criterion passed.

To run one pass against the current build:

```sh
flock --close /tmp/ezcorp-validation-heavy.lock timeout 1200 scripts/factory-graph-proof/run.sh pass mock none my-pass
```

The second argument is the mode (`ollama` or `mock`). The third is the control
(`none`, `no-pin`, or `missing-model`). The last is the record name. A single
pass does not rebuild the web server. Run `bun run --cwd web build` first if
the sources changed.

## What each pass does

1. It checks the shared stores with one read-only request each.
2. It creates fresh pool and product databases.
3. It builds the guest package in a real rootless Podman build.
4. It starts the pool, the host supervisor, Temporal behind a TLS terminator,
   the web server, and the Node orchestrator. It waits until `/api/ready`
   answers 200.
5. Through public HTTP, it creates the administrator and a project.
6. In mode `ollama`, it registers the model the way the settings page does. It
   probes the URL with `POST /api/providers/local/models`. Then it writes
   `provider:customModels` with `PUT /api/settings/provider:customModels`.
7. It binds, trusts and prepares the package for the three runner references.
   No product route does this yet, so the harness uses the product's own
   classes. The record states this.
8. Through public HTTP, it creates the definition, publishes it, and starts a
   run with `topic` set to `the primary colours of light`.
9. It waits for the run to end. Then it reads the evidence from the product
   database and reads each staged output back from the object store.
10. It stops every process. It drops both databases when the pass passed. It
    keeps the product database when the pass failed, and names it in the
    record.

## Where the results are

All paths are under `W19A_OUT`. The default is
`/tmp/factory-platform-evidence/w19a/proof`.

| File | What it holds |
| --- | --- |
| `<label>.json` | one pass: every HTTP step, the run timeline, each node's evidence, the checks, and the verdict |
| `<label>.log` | the pass's own output; the last line is its verdict |
| `<label>.server.log` | the web server's full log for that pass |
| `summary.json` | the cross-pass verdict |
| `web-build.log` | the web build |

In a record, `evidence.nodes.<node>` holds these facts for each node:

- `input`: the value the node was dispatched with, from its durable request.
- `stored`: its staged output, read back from the object store.
- `candidateOutput`: the store scope that sealed the output (run, node, generation) and its digest.
- `completionEventOutput`: the value the product read from the store when the node completed.
- `operations`: the node's journal rows. For `infer` this is the model operation, with the provider receipt digest, the measured usage, and the result.
- `model`: the model pin the attempt ran under.

## What a correct result looks like

A passing proof pass has these facts. The pass checks each one and lists it in
`checks`.

- The run timeline ends `succeeded`.
- Each node ran once.
- `combine.stored.summary` equals `"<count> words in; the model said: <answer>"`,
  where `<count>` is `prepare.stored.count` and `<answer>` is `infer.stored.answer`.
- `combine.input.value` equals `{ count, answer }` from the two stored outputs.
  `infer.input.value` equals `{ text }` from `prepare.stored`. So each node read
  its inputs from the store, not from a new computation.
- Each `completionEventOutput` equals that node's `stored` value.
- `infer.operations` has exactly one row. Its kind is `model` and its state is
  `completed`. Its usage is `measured`, with input and output tokens above zero.
- `infer.model` names the mode's provider and model, and the pinned configuration.
- `prepare` and `combine` have no operations.

`summary.json` passes when these facts hold:

- Each mode has three of three passes passed.
- `prepare` and `combine` have the same output digest in all passes of a mode.
- In mode `mock`, `infer` gave the same answer in all three passes.
- Both controls passed.

The summary records mode `ollama`'s answers as they came, next to the pinned
temperature and seed. It does not require them to be equal.

## The negative controls

Each control must be refused by name. A control pass passes when every refusal
happened.

| Control | How to run it | Correct result |
| --- | --- | --- |
| A binding to a port that does not exist | part of the `no-pin` pass | `POST .../definitions/<id>/validate` answers `valid: false` with the diagnostic `BINDING_PORT`; the draft is stored as `unavailable`; publishing it is refused with a 4xx |
| `infer` with no model pin | `run.sh pass mock no-pin control-no-pin` | `infer` fails with `model_pin_mismatch`; the journal holds no operation for it; `combine` never runs; the run ends `failed` |
| A model Ollama does not have | `run.sh pass ollama missing-model control-missing-model` | `infer` fails with `provider_unavailable`, carrying `model 'qwen3:w19a-missing' not found`; the journal holds one failed model operation with that message; `combine` never runs |

The missing-model control shows one more fact, and the record keeps it in
`heldRunFinding`. The run does not end. The failed model operation carries no
usage, so the attempt's cost is unknown. The C03 rule never settles an unknown
cost as zero, and reconciliation can clear a hold only from an operation that
carries a provider receipt. The reconciliation role therefore names the hold on
every pass: `factory_usage_hold_unresolved: no-operation-receipt`. The control
waits for that name, not for a terminal status. This is an open contract
question. It is not a harness fault.

## In a container

This harness runs the web server on the host, so `http://127.0.0.1:11434`
reaches Ollama. In a containerized deployment, register the host's Ollama as
`http://host.containers.internal:11434` (Podman) or
`http://host.docker.internal:11434` (Docker). Main #300 lets the local-provider
guard accept those two names when the container's `/etc/hosts` maps them.

## If a pass fails

- Read `failure` and `checks` in the record. Each failed check carries its detail.
- A pass that could not reach `/api/ready` records `orchestration` and
  `hostProcesses`, and the last lines of every process log in `processLogTails`.
- The product database of a failed pass is kept. Its name is in
  `retainedProductDatabase`. Drop it when you are done.
