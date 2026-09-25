# Gates: mandatory sandbox preset qualification root

Scope: Every new sandbox integration is structurally required to declare tested presets, and host activation fails closed without matching evidence.

- [x] G1: Contract leaf is fully verified.
  CHECK: node /home/dev/.agents/skills/unlazy/scripts/gate-check.mjs --status gates/sandbox-presets-contract.md
  EXPECT: /ALL MET \(4 met\)/
  EVIDENCE: gates/sandbox-presets-contract.md: 4 gates | ALL MET (4 met)

- [x] G2: Host enforcement leaf is fully verified.
  CHECK: node /home/dev/.agents/skills/unlazy/scripts/gate-check.mjs --status gates/sandbox-presets-enforcement.md
  EXPECT: /ALL MET \(4 met\)/
  EVIDENCE: gates/sandbox-presets-enforcement.md: 4 gates | ALL MET (4 met)

- [x] G3: Integration and review leaf is fully verified.
  CHECK: node /home/dev/.agents/skills/unlazy/scripts/gate-check.mjs --status gates/sandbox-presets-review.md
  EXPECT: /ALL MET \(4 met\)/
  EVIDENCE: gates/sandbox-presets-review.md: 4 gates | ALL MET (4 met)

- [x] G4: No existing user work outside assigned files was overwritten, and all implementation claims cite final checks.
  EVIDENCE: Final status and scoped diff review preserve unrelated web, design, lesson, and planning work. Claims cite pinned Bun 1.3.14 checks. The full lane reached 25,804 passes; its three unrelated workspace-hygiene failures are recorded rather than reported as green.
