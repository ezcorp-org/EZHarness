/**
 * Unit tests for the github-projects bus-registry — the indirection that lets
 * the backend poller daemon reach the web-layer SSE bus. Mirrors the contract
 * of preview-bus-registry / briefing runtime-registry: register once, read
 * back, default to undefined (so the daemon's emit degrades to a no-op).
 */
import { test, expect, describe, beforeEach } from "bun:test";
import {
  registerGithubProjectsEmit,
  getGithubProjectsEmit,
  _resetGithubProjectsEmitForTests,
  type GithubProjectsEmit,
} from "../bus-registry";
import { GITHUB_PROJECTS_EVENT } from "../types";

describe("github-projects bus-registry", () => {
  beforeEach(() => {
    _resetGithubProjectsEmitForTests();
  });

  test("returns undefined when nothing is registered (fail-safe no-op)", () => {
    expect(getGithubProjectsEmit()).toBeUndefined();
  });

  test("registered emitter is read back and forwards event + payload", () => {
    const calls: Array<{ event: string; payload: { projectId: string } }> = [];
    const emit: GithubProjectsEmit = (event, payload) => calls.push({ event, payload });
    registerGithubProjectsEmit(emit);

    const got = getGithubProjectsEmit();
    expect(got).toBeDefined();
    got?.(GITHUB_PROJECTS_EVENT, { projectId: "proj-1" });

    expect(calls).toEqual([
      { event: GITHUB_PROJECTS_EVENT, payload: { projectId: "proj-1" } },
    ]);
  });

  test("re-registering replaces the previous emitter (idempotent register)", () => {
    const first: string[] = [];
    const second: string[] = [];
    registerGithubProjectsEmit(() => first.push("first"));
    registerGithubProjectsEmit(() => second.push("second"));

    getGithubProjectsEmit()?.(GITHUB_PROJECTS_EVENT, { projectId: "p" });
    expect(first).toEqual([]);
    expect(second).toEqual(["second"]);
  });

  test("_resetGithubProjectsEmitForTests clears the registration", () => {
    registerGithubProjectsEmit(() => {});
    expect(getGithubProjectsEmit()).toBeDefined();
    _resetGithubProjectsEmitForTests();
    expect(getGithubProjectsEmit()).toBeUndefined();
  });
});
