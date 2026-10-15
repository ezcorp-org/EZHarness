# Durable successful task completion

`FactoryTaskCompletions` accepts a trusted service identity, a committed dispatch reference, and the C02 runner result. It verifies the current task, exact admitted request and compute lease, settled operation journal, measured usage, and immutable output bytes. The shared kernel validator checks the output ports. The returned receipt fits the activity payload limit.

One product transaction writes the terminal fact, settles the task budget from measured usage, enqueues the command-derived `node-result`, and saves its sealed receipt. A failed write rolls back all these facts. Exact retries read the verified terminal and saved event after the workflow advances. Changed results conflict. Receipt recovery does not grant new effect authority.

The public `completeInTransaction` and `readInTransaction` methods let the attempt dispatcher commit or recover its delivery in the same transaction. The caller must supply the authenticated private service identity. The completion store obtains project, installation, and run locks before lower-level locks.

The store accepts successful results only. Failed, cancelled, and uncertain attempts need their separate measured settlement or reconciliation path. Pool capacity remains under the supervisor and pool ledger; a product budget receipt does not prove a process has stopped. Runner launch and failure recovery are separate open implementation work.

`FactoryExecutionJournal.readCompletedTerminalInTransaction` verifies historical completed requests, settled measured operations, output bytes, and all terminal fields without creating an effect. It also returns the stored terminal timestamp. That timestamp predates the terminal seal format and is not itself a sealed authority field.
