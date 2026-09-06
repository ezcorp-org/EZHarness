# Gates: shipping crash and revocation recovery

Scope: actual process death, in-flight disable/uninstall, and repeat lifecycle resource cleanup.

- [ ] R1: Actual app death during a paused upgrade build recovers the same operation without duplicate release or unapproved activation.
  EVIDENCE: pending
- [ ] R2: Worker death before and after an owned effect exposes the correct outcome, never repeats an uncertain effect, and permits a fresh invocation.
  EVIDENCE: pending
- [ ] R3: Disable and uninstall before effect admission deny the paused handler's next real effect and retain history/data.
  EVIDENCE: pending
- [ ] R4: Repeated lifecycle and reconnect work has measured resource usage, no owned orphan workers or connections, and a stated duration/cycle count.
  EVIDENCE: pending
- [ ] R5: Runnable verification commands and controlled red/green proofs establish fault sensitivity without sleeps as ordering barriers.
  EVIDENCE: pending

