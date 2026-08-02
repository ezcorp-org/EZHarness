/**
 * The one projection from a host-side {@link BuiltinToolDef} to the
 * `AgentTool` shape pi-agent-core consumes.
 *
 * Every per-turn wire (Ez, briefing, briefing-chat, workflow) registers its
 * defs identically: record the def in the turn's `builtinToolDefsMap` — so
 * subscribe-bridge can resolve category / cardType / `callTimeoutMs` at
 * execute time — then push these five fields onto `ctx.agentTools`. Kept in
 * one place so a new `AgentTool` field is threaded once instead of once per
 * wire, and so a wire that silently drops (say) `parameters` is impossible.
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
