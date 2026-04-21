import { test, expect, describe } from "bun:test";
import { entityUrl } from "../../src/urls.js";

describe("entityUrl", () => {
  const base = "http://localhost:5173";

  test("builds a conversation URL under its project", () => {
    expect(
      entityUrl(base, { kind: "conversation", id: "conv-1", projectId: "global" }),
    ).toBe("http://localhost:5173/project/global/chat/conv-1");
  });

  test("builds an agent URL by name", () => {
    expect(entityUrl(base, { kind: "agent", name: "reviewer" })).toBe(
      "http://localhost:5173/agents/reviewer",
    );
  });

  test("url-encodes agent names with spaces", () => {
    expect(entityUrl(base, { kind: "agent", name: "my agent" })).toBe(
      "http://localhost:5173/agents/my%20agent",
    );
  });

  test("builds a run URL", () => {
    expect(entityUrl(base, { kind: "run", id: "run-42" })).toBe(
      "http://localhost:5173/runs/run-42",
    );
  });

  test("builds a project URL", () => {
    expect(entityUrl(base, { kind: "project", id: "proj-uuid" })).toBe(
      "http://localhost:5173/project/proj-uuid",
    );
  });

  test("strips a trailing slash from the base", () => {
    expect(
      entityUrl("https://example.com/", { kind: "run", id: "r1" }),
    ).toBe("https://example.com/runs/r1");
  });

  test("strips multiple trailing slashes", () => {
    expect(
      entityUrl("https://example.com///", { kind: "run", id: "r1" }),
    ).toBe("https://example.com/runs/r1");
  });

  test("works with a cross-domain HTTPS base", () => {
    expect(
      entityUrl("https://ezcorp.example.com", {
        kind: "conversation",
        id: "abc",
        projectId: "proj",
      }),
    ).toBe("https://ezcorp.example.com/project/proj/chat/abc");
  });

  test("preserves a path prefix on the base", () => {
    expect(
      entityUrl("https://ezcorp.example.com/app", { kind: "run", id: "r1" }),
    ).toBe("https://ezcorp.example.com/app/runs/r1");
  });
});
