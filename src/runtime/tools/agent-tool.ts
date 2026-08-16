/**
 * The one projection from a host-side {@link BuiltinToolDef} to the
 * `AgentTool` shape pi-agent-core consumes. Kept in one place so a new
 * `AgentTool` field is threaded once instead of once per wire, and so a
 * wire that silently drops (say) `parameters` is impossible.
 *
 * NOT the function a wire calls. It assigns `execute` RAW, and a built-in
 * registered that way runs ungated in every mode — the defect
 * `withPermissionGate` (`./permission-wrap.ts`) exists to close. Every
 * per-turn wire (project file tools, Ez, briefing, briefing-chat,
 * workflow) records the def in the turn's `builtinToolDefsMap` — so
 * subscribe-bridge can resolve category / cardType / `callTimeoutMs` at
 * execute time — and then pushes `withPermissionGate(def, deps)`, which
 * builds on this projection and overrides `execute` alone.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BuiltinToolDef } from "./types";

export function builtinToAgentTool(def: BuiltinToolDef): AgentTool {
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters,
    execute: def.execute,
  };
}
