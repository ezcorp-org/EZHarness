# Factory attempt dispatcher

The factory attempt dispatcher executes only work that the product database has admitted. The attempt queue stores an immutable command reference and runner request identity. It does not store a bearer token. Each claim reloads the exact runner request from the execution journal and checks the current run, grant, cancellation, and execution fences.

Before it mints a token, the dispatcher calls the required package readiness service. A temporary preparation gap requeues the owned claim. A permanent trust or package denial cancels the owned claim. These outcomes retain the budget and pool hold for lifecycle reconciliation. The readiness call does not build a package or run user code.

The dispatcher signs a short-lived attempt token only after readiness succeeds. It passes the token to the trusted runner outside every database transaction. A completed runner result is stored through `FactoryTaskCompletions` and the queue row becomes delivered in the same transaction.

A failed, cancelled, uncertain, invalid, or disconnected runner result becomes `outcome_unknown`. The dispatcher does not launch it again. If a database response is lost after completion commits, a later dispatch verifies the sealed completion receipt and marks the same queue row delivered without calling the runner. Recovery always uses the durable command reference bound at admission.
