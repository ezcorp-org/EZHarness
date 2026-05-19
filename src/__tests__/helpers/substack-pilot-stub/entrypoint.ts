/**
 * Stub subprocess for the chat-E2E test of substack-pilot (gap #4).
 *
 * This is NOT the real `docs/extensions/examples/substack-pilot/index.ts`
 * dispatcher. It mirrors the shape of `mock-extension/entrypoint.ts` —
 * a minimal JSON-RPC stdin/stdout loop — but routes the seven
 * substack-pilot tool names to in-memory canned responses that mimic
 * the real handlers' contract:
 *
 *   - `list_post_types`       → returns an array with the "weekly" seed
 *   - `get_post_type`         → returns the "weekly" PostType when slug matches
 *   - `summarize_urls`        → returns one summary per input URL
 *   - `generate_substack_draft` → returns a fake draft URL payload
 *
 * We use a stub instead of the real `index.ts` because the real one
 * relies on the host's storage subprocess channel + `@ezcorp/sdk`
 * runtime + a live substack-mcp child process — none of which are
 * available inside Bun's test runner without recreating the host. The
 * production code paths for those handlers are exercised by
 * `docs/extensions/examples/substack-pilot/tests/{post-types,summarize-urls,generate-draft}.test.ts`.
 *
 * What THIS stub proves is the host-side wiring: that when an agent
 * config has `extensions: [substackPilotId]`, the host spawns the
 * extension, lists tools via `tools/list`, namespaces them as
 * `substack-pilot__<tool>`, and routes `tools/call` requests with the
 * right `name` and `arguments` keys. The MockAgent in the e2e test
 * drives a 3-step tool-call sequence that crosses this boundary three
 * times, then emits a final assistant text containing the draft URL
 * the stub returned.
 */

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  ToolCallResult,
} from "../../../extensions/types";

const decoder = new TextDecoder();
let buffer = "";
const stdoutWriter = Bun.stdout.writer();

// Same Bun.stdout pattern as mock-extension/entrypoint.ts to dodge the
// fs-poison issue documented there.

async function main(): Promise<void> {
  const reader = Bun.stdin.stream().getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const request: JsonRpcRequest = JSON.parse(line);
        const response = handleRequest(request);
        stdoutWriter.write(JSON.stringify(response) + "\n");
        await stdoutWriter.flush();
      } catch {
        // Skip malformed lines (same as mock-extension)
      }
    }
  }
}

const WEEKLY_POST_TYPE = {
  name: "Weekly digest",
  slug: "weekly",
  systemPrompt:
    "You write a friendly weekly digest summarising recent reads in plain English.",
  cadence: "weekly",
  defaults: {
    titlePrefix: "Weekly digest — ",
    subtitleTemplate: "{count} reads, {date}",
  },
};

const FAKE_DRAFT_URL = "https://example.substack.com/p/weekly-2026-05-11";

function handleRequest(req: JsonRpcRequest): JsonRpcResponse {
  if (req.method === "tools/call") {
    const params = req.params as {
      name: string;
      arguments?: Record<string, unknown>;
    };
    const args = params.arguments ?? {};

    switch (params.name) {
      case "list_post_types":
        return jsonOk(req.id, {
          postTypes: [
            {
              slug: WEEKLY_POST_TYPE.slug,
              name: WEEKLY_POST_TYPE.name,
              cadence: WEEKLY_POST_TYPE.cadence,
            },
          ],
        });

      case "get_post_type": {
        const slug = args.slug;
        if (slug === WEEKLY_POST_TYPE.slug) {
          return jsonOk(req.id, { postType: WEEKLY_POST_TYPE });
        }
        return jsonErrorResult(req.id, `Post type "${String(slug)}" not found`);
      }

      case "summarize_urls": {
        const urls = (args.urls as unknown[]) ?? [];
        const summaries = urls.map((u, i) => ({
          url: String(u),
          title: `Stub title ${i + 1}`,
          summary: `Stub summary for ${String(u)} — pretend this is 80 words of useful content.`,
        }));
        return jsonOk(req.id, { summaries });
      }

      case "generate_substack_draft": {
        const slug = args.postTypeSlug;
        const urls = (args.urls as unknown[]) ?? [];
        if (slug !== WEEKLY_POST_TYPE.slug) {
          return jsonErrorResult(
            req.id,
            `Post type "${String(slug)}" not found`,
          );
        }
        return jsonOk(req.id, {
          ok: true,
          postTypeSlug: slug,
          title: "Weekly digest — May 11",
          subtitle: `${urls.length} reads, 2026-05-11`,
          urlsSummarized: urls.length,
          urlsFailed: 0,
          // The real handler returns `mcpResponse: "OK"`. We instead
          // surface a fake draft URL the assertion can pin on — this
          // gives the test a concrete artefact to look for in the
          // assistant's final text reply.
          mcpResponse: `OK draft=${FAKE_DRAFT_URL}`,
          bodyPreview: "Stub draft body preview…",
        });
      }

      // The remaining three CRUD tools (create/update/delete) aren't
      // exercised by the canonical "use weekly post type, draft from
      // URLs" flow in the e2e test. Stub them with a generic empty-ok
      // so accidental dispatches don't surface as "Unknown tool" and
      // mislead future debugging.
      case "create_post_type":
      case "update_post_type":
      case "delete_post_type":
        return jsonOk(req.id, { ok: true });

      default:
        return {
          jsonrpc: "2.0",
          id: req.id,
          error: {
            code: -32601,
            message: `Unknown tool: ${params.name}`,
          },
        };
    }
  }

  return {
    jsonrpc: "2.0",
    id: req.id,
    error: { code: -32601, message: `Unknown method: ${req.method}` },
  };
}

function jsonOk(id: JsonRpcRequest["id"], payload: unknown): JsonRpcResponse {
  const result: ToolCallResult = {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: false,
  };
  return { jsonrpc: "2.0", id, result };
}

function jsonErrorResult(
  id: JsonRpcRequest["id"],
  message: string,
): JsonRpcResponse {
  // Tool-level errors (isError:true) — NOT JSON-RPC protocol errors.
  // Mirrors the contract dispatcher-integration.test.ts pins.
  const result: ToolCallResult = {
    content: [{ type: "text", text: message }],
    isError: true,
  };
  return { jsonrpc: "2.0", id, result };
}

main();
