/**
 * Server-side load test for the /pipelines → /workflows compatibility
 * redirect (the pipelines subsystem was renamed to Workflows). The exact
 * `/pipelines` index permanently redirects (308) so a bookmarked link keeps
 * working for one release.
 */

import { test, expect, describe } from "vitest";
import { load } from "../routes/(app)/pipelines/+page.server";

describe("/pipelines/+page.server load", () => {
  test("throws a 308 permanent redirect to /workflows", async () => {
    let caught: unknown;
    try {
      await load({} as never);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { status?: number }).status).toBe(308);
    expect((caught as { location?: string }).location).toBe("/workflows");
  });
});
