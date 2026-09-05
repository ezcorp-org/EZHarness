# Workflow effect authority

- [x] Reproduce a release disabled during its first tool still dispatching its next tool.
  Evidence: `/tmp/v4-workflow-step-revocation-red.log`; actual workflow executor and SQL run persistence record `wait_tool` followed by unauthorized `late_effect`.
- [x] Capture the admitted release and host execution principal, never a newly resolved replacement definition. Use the shared transaction-aware human/service authority check.
- [x] Recheck before each batch, step, loop iteration, agent attempt and downstream tool effect. Preserve the effectless private dry-run exception.
- [x] Propagate the guard to code-agent tools, file/shell/provider calls and nested execution. Do not accept a guard from extension or workflow input.
- [x] Prove disable, replacement and grant changes stop later steps; prove actual SQL entity mutation rollback after a controlled authority change during a read. The source snapshot is a fixture; this is not a cross-connection revocation proof.
- [x] Prove long-wait tool and agent guard propagation and ordinary host compatibility. `/tmp/v4-workflow-effect-wait.log`: 18 tests, 140 assertions; an actual ToolExecutor waits for its policy response, then refuses an entity read/write after source revocation. `/tmp/v4-workflow-upstream-cancel.log`: 5 tests, 24 assertions, including upstream pre-abort and in-flight abort.
- [ ] Integrate the separate real PostgreSQL lock-order proof and durable ancestor/delegation guard, then repeat the combined tests.

External operations admitted before revocation may already have completed. This work prevents later admission; it does not claim to undo a network, shell or file effect already in progress. Restarted nested runs need durable ancestor authority, not an in-memory closure alone; the shared authority owner coordinates that check.

Focused proof: `/tmp/v4-workflow-effect-green3.log`, 133 tests, 424 assertions, including the real workflow executor, real SQL entity rollback, code-agent propagation, provider admission, ordinary workflows and the private pure dry-run factory. Production type check: `/tmp/v4-workflow-effect-types2.log`.
