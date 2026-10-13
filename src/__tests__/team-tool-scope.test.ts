/**
 * Team tool scope: which tools a team's sub-agent members may use.
 *
 * setup-tools picks the scope for the turn (`configuredTeamToolScope`,
 * `turnTeamToolScope`); start-assignment hands it to each member run as
 * allowedTools / deniedTools, and the executor applies it with
 * `applyToolFilters`. These tests drive that chain with the real functions.
 */
import { describe, expect, test } from "bun:test";
import { configuredTeamToolScope, turnTeamToolScope } from "../runtime/stream-chat/setup-tools";
import { applyToolFilters } from "../runtime/tools/filter";
import type { TeamToolScope } from "../types";

const MEMBER_TOOLS = ["read_file", "write_file", "shell_exec", "web_search", "invoke_agent"].map((name) => ({ name }));

/** The member run's tool surface under a scope, as start-assignment + the executor apply it. */
function memberTools(scope: TeamToolScope | undefined): string[] {
  if (!scope) return MEMBER_TOOLS.map((t) => t.name);
  return applyToolFilters(MEMBER_TOOLS, new Map(), {
    ...(scope.allowedTools ? { allowedTools: scope.allowedTools } : {}),
    ...(scope.deniedTools ? { deniedTools: scope.deniedTools } : {}),
  }).map((t) => t.name);
}

describe("team tool scope", () => {
  test("a team config's scope limits every member to exactly the allowed tools, minus denied ones", () => {
    const scope = turnTeamToolScope(undefined, configuredTeamToolScope({
      allowedTools: ["read_file", "web_search"],
      deniedTools: ["web_search"],
    }));
    // invoke_agent is an orchestration tool, which scopes never remove.
    expect(memberTools(scope)).toEqual(["read_file", "invoke_agent"]);
  });

  test("a denied-only scope removes just those tools", () => {
    expect(memberTools(configuredTeamToolScope({ deniedTools: ["shell_exec"] })))
      .toEqual(["read_file", "write_file", "web_search", "invoke_agent"]);
  });

  test("a scope that restricts nothing is no scope", () => {
    expect(configuredTeamToolScope({ allowedTools: [], deniedTools: [] })).toBeUndefined();
    expect(configuredTeamToolScope(undefined)).toBeUndefined();
  });

  test("a team mentioned in the message wins over the agent config's own scope", () => {
    const configured = configuredTeamToolScope({ allowedTools: ["write_file"] });
    const mentioned: TeamToolScope = { allowedTools: ["read_file"] };
    expect(memberTools(turnTeamToolScope(mentioned, configured))).toEqual(["read_file", "invoke_agent"]);
    expect(memberTools(turnTeamToolScope(undefined, configured))).toEqual(["write_file", "invoke_agent"]);
  });
});
