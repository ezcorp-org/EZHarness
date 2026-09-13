# Private factory command dispatch

`FactoryPrivateCommands` implements the Bun private service command boundary. It accepts the service identity verified by mTLS and the service token, plus the stored tenant/project/run/interpreter/command reference. It captures those values before any asynchronous work and routes by the kind in the verified immutable transition. Request JSON does not choose the effect handler or supply runner input, grants, resources, or package identity.

Task reservation and execution admission use the existing product stores and acknowledge only after their durable transactions return. Completion reaches the interpreter through the existing inbox. Lazy reads, generic human approvals, and exact child resolution use their current-authority stores.

The constructor requires explicit cancellation, acceptance, release, and partition-delivery handlers. Each such module must verify the current command and commit its own receipt transaction. No default effect handler is supplied. Orchestration-local timers, child-launch commands, and terminal commands cannot use the generic execution route. Child definition resolution has its own exact reference method. Full process startup still needs the complete concrete effect and runner composition.

The product conformance suite runs actual published factories, committed transitions, native runner policy, journal/queue admission, lazy artifact reads, child binding, and generic approvals through this router. A real Node client also submits a forged request body over mTLS to the Bun private server: the durable request contains only the committed command and current native policy. Repeated submissions reuse the same durable attempt.
