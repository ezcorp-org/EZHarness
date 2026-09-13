# Factory task execution admission

`FactoryTaskExecutionAdmission` converts one current `dispatch-node` command into one durable runner attempt. It performs this work in the command-authority transaction:

1. Lock and verify the stored command, run fence, compiled task, and durable initiator.
2. Read the exact admitted compute request and pool lease. The budget reservation must still be `running`.
3. Ask the configured runner policy to verify package trust, current grants, model policy, tool policy, and the broker audience.
4. Allocate the operation cursor, store the token-free `FactoryRunnerRequestIdentity`, and enqueue its reference in the shared durable delivery queue.

The attempt ID is the immutable dispatch command ID. The reservation ID is `factoryTaskReservationId`. The stored deadline is the original pool lease deadline. An exact retry returns the committed runner identity, including its original cursor and deadline. A changed runner policy, request identity, allocation fence, run fence, or command fails closed.

The product database never stores a bearer token in this path. The runner dispatcher must mint a fresh, short-lived attempt token after it claims the queue entry. `FactoryTaskRunnerPolicy` has no default implementation. Product composition must provide a resolver that verifies the native runner package and all current grant, model, and tool facts.
