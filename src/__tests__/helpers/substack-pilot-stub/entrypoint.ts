import type {
  JsonRpcRequest,
  JsonRpcResponse,
  ToolCallResult,
} from "../../../extensions/types";

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

export function handleRequest(req: JsonRpcRequest): JsonRpcResponse {
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
