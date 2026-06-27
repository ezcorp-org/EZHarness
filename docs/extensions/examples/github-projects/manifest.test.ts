/**
 * Manifest smoke test for the github-projects bundled extension.
 *
 * Importing the config executes `defineExtension(...)`, which validates the
 * manifest and gives the coverage gate a measured line for ezcorp.config.ts.
 * The assertions also pin the security-load-bearing shape: the six thin tools,
 * the single Hub page, `bootSpawn`, and — critically — that the subprocess is
 * granted NO network / shell / env (all GitHub I/O is host-side).
 */
import { describe, expect, test } from "bun:test";
import config from "./ezcorp.config";

describe("github-projects manifest", () => {
  test("identity + bootSpawn", () => {
    expect(config.name).toBe("github-projects");
    expect(config.schemaVersion).toBe(2);
    expect(config.bootSpawn).toBe(true);
    expect(config.entrypoint).toBeTruthy();
  });

  test("exposes exactly the six thin ticket tools", () => {
    const names = (config.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(
      ["add_comment", "archive_ticket", "create_ticket", "list_tickets", "move_ticket", "update_ticket"].sort(),
    );
  });

  test("declares a single Hub dashboard page", () => {
    expect(config.pages).toHaveLength(1);
    expect(config.pages?.[0]?.id).toBe("dashboard");
  });

  test("the subprocess gets NO network / shell / env (host-side I/O only)", () => {
    const perms = config.permissions ?? {};
    expect(perms.network).toBeUndefined();
    expect(perms.shell).toBeFalsy();
    expect(perms.env).toBeUndefined();
    // The page-action events are declared so the Hub buttons clear the gate.
    expect(perms.eventSubscriptions).toEqual(
      expect.arrayContaining(["github-projects:approve", "github-projects:dismiss"]),
    );
  });
});
