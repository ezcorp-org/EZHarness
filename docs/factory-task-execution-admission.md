# Factory task execution admission

`FactoryTaskExecutionAdmission` converts one current `dispatch-node` command into one durable runner attempt. It performs this work in the command-authority transaction:

1. Lock and verify the stored command, run fence, compiled task, and durable initiator.
2. Read the exact admitted compute request and pool lease. The budget reservation must still be `running`.
3. Ask the configured runner policy to verify package trust, current grants, model policy, tool policy, and the broker audience.
4. Allocate the operation cursor, store the token-free `FactoryRunnerRequestIdentity`, and enqueue its reference in the shared durable delivery queue.

The attempt ID is the immutable dispatch command ID. The reservation ID is `factoryTaskReservationId`. The stored deadline is the original pool lease deadline. An exact retry returns the committed runner identity, including its original cursor and deadline. A changed runner policy, request identity, allocation fence, run fence, or command fails closed.

The product database never stores a bearer token in this path. After it claims the queue entry and before it mints a fresh, short-lived attempt token, the dispatcher reads the current prepared-package receipt for the exact runner tuple. A missing receipt may retry preparation. A revoked, stale, corrupt, foreign, or untrusted receipt denies dispatch. The dispatcher does not perform package preparation or use a process-local readiness cache.

`FactoryNativeRunnerPolicy` is the strict production resolver for the built-in native runner. Boot supplies exact runner profiles from trusted operator configuration. Each profile fixes the package pin, resource ceiling, allowed capabilities, optional model configuration and policy digests, and capability-bound tool declarations. Admission rechecks the initiator's current `factory.run` grant and requires the package to match both the compiled dependency lock and a configured profile. It uses the admitted compute budget and memory ceiling in the durable runner request.

The native policy does not call the mutable host model router or the process-global extension registry. Provider credentials remain behind the attempt broker. Unknown packages, profiles, capabilities, resources, models, and tools fail closed.
