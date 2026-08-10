/**
 * Unit tests for `parseProposeCardResult` — the `ez-propose` card parser
 * that turns a concierge `propose_*` tool's `{ draftId, openUrl }` output
 * into the EzToolResultCard render props.
 *
 * Regression guard for the "no prefilled form appeared" bug: the parser
 * must recover `openUrl` from the JSON-string output the store hands it
 * (and from a raw MCP envelope, defensively), and must return null when
 * there's no usable `openUrl` so the router falls back to DefaultCard.
 */

import { test, expect, describe } from "bun:test";
import { parseProposeCardResult } from "../lib/components/tool-cards/ez-propose-card-logic.js";

describe("parseProposeCardResult", () => {
  test("parses a JSON-string output (the real propose_create_project shape)", () => {
    const output = JSON.stringify({
      draftId: "381af91d",
      openUrl: "/new-project?prefill=381af91d",
    });
    expect(parseProposeCardResult(output)).toEqual({
      openUrl: "/new-project?prefill=381af91d",
      draftId: "381af91d",
    });
  });

  test("parses agent + extension propose urls too", () => {
    expect(
      parseProposeCardResult(JSON.stringify({ draftId: "d", openUrl: "/agents/new?prefill=d" }))
        ?.openUrl,
    ).toBe("/agents/new?prefill=d");
    expect(
      parseProposeCardResult(JSON.stringify({ draftId: "d2", openUrl: "/marketplace?q=foo" }))
        ?.openUrl,
    ).toBe("/marketplace?q=foo");
  });

  test("defensively unwraps a raw MCP {content:[{text}]} envelope", () => {
    const output = {
      content: [
        { type: "text", text: JSON.stringify({ draftId: "x", openUrl: "/new-project?prefill=x" }) },
      ],
    };
    expect(parseProposeCardResult(output)).toEqual({
      openUrl: "/new-project?prefill=x",
      draftId: "x",
    });
  });

  test("omits draftId when absent but keeps a usable openUrl", () => {
    expect(parseProposeCardResult(JSON.stringify({ openUrl: "/new-project" }))).toEqual({
      openUrl: "/new-project",
    });
  });

  test("returns null when openUrl is missing/empty (router falls back to DefaultCard)", () => {
    expect(parseProposeCardResult(JSON.stringify({ draftId: "d" }))).toBeNull();
    expect(parseProposeCardResult(JSON.stringify({ openUrl: "" }))).toBeNull();
  });

  test("returns null for non-JSON / non-object output", () => {
    expect(parseProposeCardResult("not json")).toBeNull();
    expect(parseProposeCardResult(undefined)).toBeNull();
    expect(parseProposeCardResult(42)).toBeNull();
  });
});
