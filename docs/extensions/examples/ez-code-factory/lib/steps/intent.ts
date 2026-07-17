// ── Intent step (v0) — explicit intent only ─────────────────────────
//
// M1 supports EXPLICIT intent only: `git push gate -o intent="…"` (parsed into
// run.intent at push time, provenance "agent" = authoritative). When intent is
// present the step is a no-op that logs it; when absent the step is SKIPPED —
// it NEVER fails the run. Transcript-based inference (upstream's IntentStep)
// lands in M5. Ported behaviour from internal/pipeline/steps/intent.go's
// agent-supplied-intent early return + the disabled-extraction skip path.

import type { Step, StepContext, StepOutcome } from "./common";

export const intentStep: Step = {
  name: "intent",
  async execute(sctx: StepContext): Promise<StepOutcome> {
    if (sctx.run.intent !== null && sctx.run.intent.trim() !== "") {
      sctx.log("using intent supplied by the agent");
      return {};
    }
    // No explicit intent, and inference is not implemented until M5. Skip
    // without failing — a missing intent must never block the pipeline.
    sctx.log("no explicit intent supplied (transcript inference lands in M5)");
    return { skipped: true };
  },
};
