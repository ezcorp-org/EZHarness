# Gates: hardening

- [ ] G1: C05 reserved-path and environment leak denials pass regression cases.
  EVIDENCE: pending

- [ ] G2: Factory shell/MCP paths fail before spawning without required isolation.
  EVIDENCE: pending

- [ ] G3: Installation-bound JWT rejects missing/foreign audience and issuer.
  EVIDENCE: pending

- [ ] G4: Factory flag is exact, read at boot, and rejects embedded mode when enabled.
  EVIDENCE: pending

- [ ] G5: Focused regression and measured new/changed-line coverage pass.
  EVIDENCE: pending

Note (W00 audit 2026-09-13): the gates above remain formally pending, but the corresponding source is in the integration branch and its component legs passed at ancestor heads (see docs/validation/factory/w00/requirement-index.md). They close only when re-run on the final candidate under W20.
