// ── post-types-port — no-regression gate vs pre-port shape ───────
//
// Commit `5b2109c` ported substack-pilot's hand-rolled
// `lib/post-types.ts` (~421 LOC) to the defineEntity SDK's
// auto-generated tools (declared in `ezcorp.config.ts:entities[]`).
// This test guards that the SDK-generated tools produce
// semantically-equivalent payloads to the pre-port wrappers for each
// of the 5 CRUD operations.
//
// Adapter contract (NOT byte-identical — see `fixtures/README.md`):
//   Pre-port tools wrapped responses in toolResult() with prose
//   prefixes (e.g. `"Created post type \"weekly\" (...).\n<JSON>"`).
//   The SDK-generated tools return just the JSON envelope. The
//   adapter strips the envelope down to the *PostType record* the
//   old prose wrapped and compares that to the frozen fixture.
//
// Coverage: list / get / create / update / delete — one test each.
// The store is an in-memory `EntityStoreLike` (the SDK's pure
// interface), so this test doesn't touch the host DB or the
// substack-pilot subprocess. It exercises the SDK contract that the
// host-served dispatcher uses verbatim in production.

import { describe, expect, test } from "bun:test";
import {
  buildEntityToolHandlers,
  type EntityDeclaration,
  type EntityStoreLike,
} from "@ezcorp/sdk/entities";
import manifest from "../ezcorp.config";
import listFixture from "./fixtures/list-post-types.before.json";
import getFixture from "./fixtures/get-post-type-weekly.before.json";
import createFixture from "./fixtures/create-post-type-monthly.before.json";
import updateFixture from "./fixtures/update-post-type-weekly.before.json";
import deleteFixture from "./fixtures/delete-post-type-monthly.before.json";

// In-memory store mirroring `EntityStoreLike`'s 3-method shape.
function makeMemStore(): EntityStoreLike {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      if (!map.has(key)) return { value: null as T | null, exists: false };
      return { value: map.get(key) as T, exists: true };
    },
    async set(key, value) {
      map.set(key, value);
      return { ok: true };
    },
    async delete(key) {
      const had = map.delete(key);
      return { deleted: had };
    },
  };
}

const decl = (manifest.entities ?? []).find(
  (e: EntityDeclaration) => e.type === "post-type",
);
if (!decl) {
  throw new Error("post-type entity declaration missing from manifest");
}

// Parse a toolResult content block back to the structured envelope.
// The SDK's tool handlers return `{content: [{type: "text", text: <JSON>}]}`
// for success and `{content: [...], isError: true}` for errors.
function parseToolResult(result: unknown): {
  ok: boolean;
  data: unknown;
  raw: string;
} {
  const r = result as {
    isError?: boolean;
    content?: Array<{ type: string; text: string }>;
  };
  const text = r.content?.[0]?.text ?? "";
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { ok: !r.isError, data: parsed, raw: text };
}

describe("post-types-port — SDK output matches pre-port fixtures", () => {
  test("list_post_types: items[].{slug, data} → PostTypeSummary[]", async () => {
    const store = makeMemStore();
    const h = buildEntityToolHandlers(decl, store, { softRead: false });
    // Seed two records to mirror the fixture.
    for (const item of listFixture.postTypes) {
      const data: Record<string, unknown> = {
        name: item.name,
        // The pre-port `list` returned only summary fields; the
        // SDK's store keeps the full record. We populate plausible
        // values for the required schema fields so the create call
        // path matches the schema.
        systemPrompt: `seed:${item.slug}`,
      };
      if (item.cadence !== undefined) data.cadence = item.cadence;
      await h.create({ slug: item.slug, data });
    }

    const result = parseToolResult(await h.list({}));
    expect(result.ok).toBe(true);
    const body = result.data as {
      items: Array<{ slug: string; data: { name: string; cadence?: string } }>;
    };
    // Adapter: project SDK output down to the pre-port summary shape.
    const summaries = body.items
      .map((i) => ({
        slug: i.slug,
        name: i.data.name,
        ...(i.data.cadence !== undefined ? { cadence: i.data.cadence } : {}),
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
    const expected = [...listFixture.postTypes].sort((a, b) =>
      a.slug.localeCompare(b.slug),
    );
    expect(summaries).toEqual(expected);
  });

  test("get_post_type: {slug, data} → PostType record", async () => {
    const store = makeMemStore();
    const h = buildEntityToolHandlers(decl, store, { softRead: false });
    // Seed the weekly record matching the fixture (minus the
    // pre-port duplicated `slug` key inside `data`; the SDK stores
    // slug at the envelope level only).
    const seedData: Record<string, unknown> = {
      name: getFixture.name,
      systemPrompt: getFixture.systemPrompt,
      cadence: getFixture.cadence,
      defaults: getFixture.defaults,
    };
    await h.create({ slug: getFixture.slug, data: seedData });

    const result = parseToolResult(
      await h.get({ slug: getFixture.slug }),
    );
    expect(result.ok).toBe(true);
    const body = result.data as { slug: string; data: Record<string, unknown> };
    // Adapter: re-attach `slug` inside data to match the pre-port shape.
    const reconstructed = { ...body.data, slug: body.slug };
    expect(reconstructed).toEqual(getFixture);
  });

  test("create_post_type: returns {slug, data} matching the input", async () => {
    const store = makeMemStore();
    const h = buildEntityToolHandlers(decl, store, { softRead: false });
    const inputData: Record<string, unknown> = {
      name: createFixture.name,
      systemPrompt: createFixture.systemPrompt,
      cadence: createFixture.cadence,
      defaults: createFixture.defaults,
    };
    const result = parseToolResult(
      await h.create({ slug: createFixture.slug, data: inputData }),
    );
    expect(result.ok).toBe(true);
    const body = result.data as { slug: string; data: Record<string, unknown> };
    const reconstructed = { ...body.data, slug: body.slug };
    expect(reconstructed).toEqual(createFixture);
  });

  test("update_post_type: shallow-merges patch onto current record", async () => {
    const store = makeMemStore();
    const h = buildEntityToolHandlers(decl, store, { softRead: false });
    // Seed the original weekly record.
    await h.create({
      slug: "weekly",
      data: {
        name: "Weekly Roundup",
        systemPrompt: getFixture.systemPrompt,
        cadence: getFixture.cadence,
        defaults: getFixture.defaults,
      },
    });
    // Apply a name-only patch — matches pre-port `updatePostType`
    // shallow-merge semantics.
    const result = parseToolResult(
      await h.update({
        slug: "weekly",
        patch: { name: updateFixture.name },
      }),
    );
    expect(result.ok).toBe(true);
    const body = result.data as { slug: string; data: Record<string, unknown> };
    const reconstructed = { ...body.data, slug: body.slug };
    expect(reconstructed).toEqual(updateFixture);
  });

  test("delete_post_type: returns {deleted: true} on a removed record", async () => {
    const store = makeMemStore();
    const h = buildEntityToolHandlers(decl, store, { softRead: false });
    await h.create({
      slug: "monthly",
      data: {
        name: "Monthly Essay",
        systemPrompt: "x",
        cadence: "monthly",
      },
    });
    const result = parseToolResult(await h.delete({ slug: "monthly" }));
    expect(result.ok).toBe(true);
    // Adapter: pre-port `deletePostType` returned `{deleted: boolean}`;
    // the SDK returns the same shape verbatim.
    expect(result.data).toEqual(deleteFixture);
  });
});
