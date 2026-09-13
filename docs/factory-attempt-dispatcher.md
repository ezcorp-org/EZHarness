# Factory attempt dispatcher

The factory attempt dispatcher executes only work that the product database has admitted. The attempt queue stores an immutable command reference, compute reservation ID, and runner request identity. It does not store a bearer token. Each claim reloads the exact runner request from the execution journal and checks the current run, grant, cancellation, and execution fences.

Before it mints a token, the dispatcher calls the required package readiness service. A temporary preparation gap requeues the owned claim. A permanent trust or package denial cancels the owned claim. These outcomes retain the budget and pool hold for lifecycle reconciliation. The readiness call does not build a package or run user code.

The dispatcher signs a short-lived attempt token only after readiness succeeds. It passes the token to the trusted runner outside every database transaction. A completed runner result is stored through `FactoryTaskCompletions` and the queue row becomes delivered in the same transaction.

A valid failed, cancelled, or uncertain runner result is verified against the exact request, operation journal, and cursor. `FactoryTaskOutcomes` stores that result, a small `node-failed` event, and a sealed receipt before the queue becomes delivered. Failed and cancelled results keep the budget in `running`; explicit uncertainty changes it to `uncertain`. Neither path releases capacity or permits retry before a trusted physical stop.

An invalid or disconnected runner result becomes `outcome_unknown`. The dispatcher does not launch it again. If a database response is lost after a completion or non-success outcome commits, a later dispatch verifies the sealed historical receipt and marks the same queue row delivered without calling the runner. Recovery always uses the durable command and reservation references bound at admission.

Physical cancellation and stop acknowledgement are a separate C02 phase. A host supervisor must prove that no process remains before usage and pool capacity can settle. The `node-failed` event makes the kernel emit `cancel-node`; it does not itself prove a stop.
