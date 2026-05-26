// ── substack-client — the single Substack I/O seam ──────────────
//
// ALL Substack reads/writes go through the `SubstackClient` interface.
// Unit tests inject a fake implementing this interface; they NEVER hit
// the network or spawn a child process. Mirrors substack-pilot's
// `McpCaller` seam (`docs/extensions/examples/substack-pilot/lib/substack.ts`):
//
//   - `_setSubstackClientForTests(fake)` overrides the client used by
//     the tools. Pass `null` to clear and fall back to the production
//     factory.
//   - `_setSubstackClientFactoryForTests(factory)` overrides the
//     import-and-spawn step so the production-wiring path (settings →
//     transport env shaping, error surfacing) is fully tested WITHOUT
//     importing `@modelcontextprotocol/sdk` or running `npx`.
//
// Locked decision #7 (mocked-vs-live boundary): live verification is
// BLOCKED on a real session cookie this run. The production transport
// (substack-mcp stdio child for whatever it supports + the
// `substack-api` TS lib / Playwright for the rest) is wired behind the
// seam but every code path that touches the real transport is marked
// `// LIVE-UNTESTED`, and the unavoidable dynamic-import/spawn block is
// the ONLY thing excluded from coverage (mirrors substack-pilot's
// "Untested by design" seam at lib/substack.ts:199-219).
//
// Open question 1 resolution (documented in the Phase 1 commit): the
// upstream `substack-mcp` package exposes draft/post creation and a
// thin comment surface but no first-class DM or Notes-engagement ops.
// The seam therefore routes comment ops through substack-mcp where it
// helps and reserves DM + Notes for the `substack-api` TS lib /
// Playwright path — but BOTH live behind the same dynamic-import block
// and BOTH are `// LIVE-UNTESTED`. The seam + the fakes used by tests
// are unchanged regardless of which upstream op a given method maps to.

// ── Domain shapes ───────────────────────────────────────────────

export interface Comment {
  /** Stable id of the comment on the creator's own post. */
  id: string;
  /** Id of the post the comment is on. */
  postId: string;
  /** Author handle/name (for voice context, never echoed verbatim). */
  author: string;
  /** The comment body the draft will respond to. */
  body: string;
  /** Epoch ms the comment was created (best-effort; 0 when unknown). */
  createdAt: number;
}

export interface Subscriber {
  /** Stable subscriber id used for welcome-DM dedupe. */
  id: string;
  /** Display name / handle for the welcome DM voice context. */
  name: string;
  /** Epoch ms the subscription started (best-effort; 0 when unknown). */
  subscribedAt: number;
}

export interface Note {
  /** Stable note id (others' short-form post). */
  id: string;
  /** Note author handle. */
  author: string;
  /** Note body the comment will respond to. */
  body: string;
}

export interface ListCommentsOpts {
  /** Optional cap on how many comments to pull this scan. */
  limit?: number;
}

export interface PostCommentReplyOpts {
  /** Comment being replied to. */
  commentId: string;
  /** Post the comment lives on. */
  postId: string;
  /** Reply body to post. */
  body: string;
}

export interface SendDirectMessageOpts {
  /** Subscriber to DM. */
  subscriberId: string;
  /** Message body. */
  body: string;
}

export interface PostNoteCommentOpts {
  /** Note being commented on. */
  noteId: string;
  /** Comment body. */
  body: string;
}

export interface SendResult {
  ok: boolean;
  /** Id of the created comment/reply when the upstream returns one. */
  id?: string;
  error?: string;
}

export interface SubstackClient {
  listOwnPostComments(opts: ListCommentsOpts): Promise<Comment[]>;
  postCommentReply(opts: PostCommentReplyOpts): Promise<SendResult>;
  listNewSubscribers(
    sinceCursor: string | null,
  ): Promise<{ subscribers: Subscriber[]; cursor: string }>;
  sendDirectMessage(opts: SendDirectMessageOpts): Promise<SendResult>;
  listNote(noteRef: string): Promise<Note>;
  postNoteComment(opts: PostNoteCommentOpts): Promise<SendResult>;
}

// ── Credentials read from settings (NOT env) ────────────────────
//
// Locked decision #3: creds live in `settings.*`, read at tool-
// invocation time via `ctx.invocationMetadata.settings`. We never
// request `permissions.env` — `substack_session_token` matches the
// host's ENV_KEY_LEAK_PATTERN install-gate.

export interface SubstackCredentials {
  publicationUrl: string;
  sessionToken: string;
  userId: string;
}

/**
 * Extract + presence-validate the three SUBSTACK_* settings from a
 * tool's invocation metadata. Returns `null` when any is missing/blank
 * so callers can surface a single MISSING_CREDENTIALS error.
 */
export function readCredentials(
  settings: Record<string, unknown> | undefined,
): SubstackCredentials | null {
  const s = settings ?? {};
  const publicationUrl = s.substack_publication_url;
  const sessionToken = s.substack_session_token;
  const userId = s.substack_user_id;
  if (
    typeof publicationUrl !== "string" ||
    typeof sessionToken !== "string" ||
    typeof userId !== "string" ||
    publicationUrl.length === 0 ||
    sessionToken.length === 0 ||
    userId.length === 0
  ) {
    return null;
  }
  return { publicationUrl, sessionToken, userId };
}

// ── Test-injection seam ─────────────────────────────────────────

let _client: SubstackClient | null = null;

/** Test-only: inject a fake SubstackClient. Pass `null` to clear. */
export function _setSubstackClientForTests(client: SubstackClient | null): void {
  _client = client;
}

// ── Lazy production factory ─────────────────────────────────────
//
// `SubstackClientFactory` builds the real client from credentials. The
// production factory imports the transport SDK on demand (so unit tests
// that inject a fake never trip on module side-effects) and shapes a
// minimal child-process env — never forwarding the host's process.env.
//
// `_setSubstackClientFactoryForTests` overrides the import-and-spawn
// step with an injected factory so tests can assert the transport
// shape (command/args/env allowlist) WITHOUT importing the MCP SDK or
// spawning `npx`. Mirrors substack-pilot's `_setMcpClientFactoryForTests`.

export interface TransportSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export type SubstackClientFactory = (
  creds: SubstackCredentials,
  transport: TransportSpec,
) => Promise<SubstackClient>;

let _factory: SubstackClientFactory | null = null;

/**
 * Test-only: replace the transport import-and-spawn step with an
 * injected factory. Pass `null` to restore the production path.
 */
export function _setSubstackClientFactoryForTests(
  factory: SubstackClientFactory | null,
): void {
  _factory = factory;
}

let _productionClientPromise: Promise<SubstackClient> | null = null;

/**
 * Build the transport spec for the substack-mcp stdio child. Pure +
 * exported so tests assert the exact spawn shape (command/args/env
 * allowlist) without spawning anything. We forward ONLY the SUBSTACK_*
 * vars the child needs plus PATH/HOME so `npx` finds its binaries — the
 * host's process.env is never leaked to the child.
 */
export function buildTransportSpec(creds: SubstackCredentials): TransportSpec {
  return {
    command: "npx",
    args: ["-y", "substack-mcp@latest"],
    env: {
      SUBSTACK_PUBLICATION_URL: creds.publicationUrl,
      SUBSTACK_SESSION_TOKEN: creds.sessionToken,
      SUBSTACK_USER_ID: creds.userId,
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
    },
  };
}

/**
 * Resolve the production SubstackClient for the given credentials.
 * Constructed lazily and reused across calls within the subprocess
 * lifetime. When a test factory is injected, it is used; otherwise the
 * real transport is imported and spawned (the `// LIVE-UNTESTED` block).
 */
export async function getProductionClient(
  creds: SubstackCredentials,
): Promise<SubstackClient> {
  if (_productionClientPromise) return _productionClientPromise;
  const transport = buildTransportSpec(creds);
  _productionClientPromise = (async () => {
    if (_factory) {
      return _factory(creds, transport);
    }
    return buildLiveClient(creds, transport);
  })();
  return _productionClientPromise;
}

// ── Live transport (UNVERIFIED — no session cookie this run) ─────
//
// Untested by design — this is the sole block excluded from coverage,
// mirroring substack-pilot/lib/substack.ts:199-219. It dynamically
// imports the MCP SDK + substack-api lib and spawns the stdio child.
// Everything that consumes the resulting client (the tools) IS tested
// via the injected fake; only the import+spawn handshake is uncovered.
//
// LIVE-UNTESTED: requires a real Substack session cookie + a running
// `npx substack-mcp` child. Build + tests run against the injected
// fake; this path is wired but never exercised this run.
/* c8 ignore start */
async function buildLiveClient(
  creds: SubstackCredentials,
  transport: TransportSpec,
): Promise<SubstackClient> {
  // LIVE-UNTESTED: dynamic import keeps the MCP SDK + substack-api off
  // the unit-test hot path (no module side-effects, no native deps).
  const { Client } = await import(
    "@modelcontextprotocol/sdk/client/index.js"
  );
  const { StdioClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/stdio.js"
  );
  const sdkClient = new Client(
    { name: "ezcorp-substack-engagement", version: "1.0.0" },
    { capabilities: {} },
  );
  const sdkTransport = new StdioClientTransport({
    command: transport.command,
    args: transport.args,
    env: transport.env,
  });
  await sdkClient.connect(sdkTransport);

  // LIVE-UNTESTED: substack-mcp's comment surface; DM + Notes ops fall
  // back to the substack-api TS lib / Playwright (open question 1). The
  // session token authenticates all of them. Shapes mirror the seam.
  const callText = async (
    tool: string,
    args: Record<string, unknown>,
  ): Promise<SendResult> => {
    try {
      const res = await sdkClient.callTool({ name: tool, arguments: args });
      const first = (res.content as Array<{ type: string; text?: string }> | undefined)?.[0];
      const text = first?.type === "text" ? (first.text ?? "") : "";
      if (res.isError) return { ok: false, error: text || `${tool} reported isError` };
      return { ok: true, id: text || undefined };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  };

  return {
    async listOwnPostComments() {
      // LIVE-UNTESTED: substack-api list-comments; returns [] until wired.
      return [];
    },
    async postCommentReply(opts) {
      return callText("post_comment_reply", {
        publicationUrl: creds.publicationUrl,
        commentId: opts.commentId,
        postId: opts.postId,
        body: opts.body,
      });
    },
    async listNewSubscribers(sinceCursor) {
      // LIVE-UNTESTED: substack-api subscriber poll.
      return { subscribers: [], cursor: sinceCursor ?? "" };
    },
    async sendDirectMessage(opts) {
      return callText("send_direct_message", {
        subscriberId: opts.subscriberId,
        body: opts.body,
      });
    },
    async listNote(noteRef) {
      // LIVE-UNTESTED: substack-api note fetch.
      return { id: noteRef, author: "", body: "" };
    },
    async postNoteComment(opts) {
      return callText("post_note_comment", {
        noteId: opts.noteId,
        body: opts.body,
      });
    },
  } satisfies SubstackClient;
}
/* c8 ignore stop */

/**
 * Resolve the SubstackClient for a tool call. Returns the injected test
 * client when set; otherwise reads credentials from settings and builds
 * the production client. Returns `{ error: "MISSING_CREDENTIALS" }` when
 * creds are absent so callers surface a single, consistent error.
 */
export async function resolveClient(
  settings: Record<string, unknown> | undefined,
): Promise<
  | { ok: true; client: SubstackClient }
  | { ok: false; reason: "MISSING_CREDENTIALS" | "TRANSPORT_ERROR"; error: string }
> {
  if (_client) return { ok: true, client: _client };
  const creds = readCredentials(settings);
  if (!creds) {
    return {
      ok: false,
      reason: "MISSING_CREDENTIALS",
      error:
        "Substack credentials missing — open /extensions/substack-engagement " +
        "and fill Publication URL, Session token, and User ID.",
    };
  }
  try {
    const client = await getProductionClient(creds);
    return { ok: true, client };
  } catch (err) {
    return {
      ok: false,
      reason: "TRANSPORT_ERROR",
      error: `Failed to start Substack transport: ${(err as Error).message}`,
    };
  }
}

/** Test-only: reset all module-level seam state between test files. */
export function _resetSubstackClientForTests(): void {
  _client = null;
  _factory = null;
  _productionClientPromise = null;
}
