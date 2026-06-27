/**
 * Host GitHub Projects v2 client.  ──  OWNED BY AGENT A.
 *
 * Real implementation of the `GithubClient` interface frozen in `./types`.
 * GitHub Projects v2 is GraphQL-only (POST https://api.github.com/graphql);
 * issues + comments are REST (https://api.github.com/...). Every request is
 * pinned to GITHUB_API_ORIGIN by `assertGithubHost` (SSRF guard) and carries a
 * bearer token that is HOST-ONLY: it is never logged and never returned.
 *
 * The client treats `pat` and `gh` auth identically — both are a resolved
 * bearer token. `gh auth token` resolution happens in the daemon/handler layer,
 * NOT here; the client never shells out.
 *
 * Other agents only IMPORT `createGithubClient` (and mock it in their tests);
 * they never edit this file.
 */
import {
  GITHUB_API_ORIGIN,
  GithubAuthError,
  type GithubAuth,
  type GithubAuthValidation,
  type GithubBoardItem,
  type GithubBoardRef,
  type GithubClient,
  type GithubCreateTicketInput,
  type GithubFetchPage,
  GithubHostNotAllowedError,
  GithubNotFoundError,
  GithubRateLimitError,
  type GithubStatusOption,
  type GithubTicketRef,
  type GithubUpdateTicketInput,
} from "./types";

const GRAPHQL_URL = `${GITHUB_API_ORIGIN}/graphql`;
const USER_AGENT = "ezcorp-github-projects";
const STATUS_FIELD_NAME = "Status";

/**
 * SSRF guard: every request URL MUST resolve to the GitHub API origin. A
 * non-GitHub origin (or an unparseable URL) throws GithubHostNotAllowedError.
 * The token never appears in the thrown message. Callers pass this every URL
 * derived from any user-influenceable input (e.g. an item's html_url).
 */
function assertGithubHost(url: string): void {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    // A non-string-URL or syntactically invalid value — refuse outright.
    throw new GithubHostNotAllowedError("Refusing to fetch a malformed URL");
  }
  if (origin !== GITHUB_API_ORIGIN) {
    throw new GithubHostNotAllowedError(
      `Refusing to fetch non-GitHub host ${origin} (only ${GITHUB_API_ORIGIN} is allowed)`,
    );
  }
}

/** Parse the `x-oauth-scopes` header (classic PATs) into a trimmed list. */
function parseScopes(headers: Headers): string[] {
  const raw = headers.get("x-oauth-scopes");
  if (raw === null) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Compute a back-off delay (ms) from rate-limit response headers. */
function retryAfterMsFromHeaders(headers: Headers): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset !== null) {
    const resetSec = Number(reset);
    if (Number.isFinite(resetSec)) {
      return Math.max(0, resetSec * 1000 - Date.now());
    }
  }
  return undefined;
}

/** True when a 403 response carries secondary/primary rate-limit signals. */
function isRateLimited(res: Response): boolean {
  if (res.headers.get("retry-after") !== null) return true;
  return res.headers.get("x-ratelimit-remaining") === "0";
}

/**
 * Map a non-2xx HTTP response to a typed error. The response body text (which
 * never contains the token) is folded into the message for diagnosability.
 */
function errorForStatus(res: Response, bodyText: string, context: string): Error {
  const detail = bodyText ? `: ${bodyText}` : "";
  if (res.status === 401) {
    return new GithubAuthError(`${context} failed (401 unauthorized)${detail}`);
  }
  if (res.status === 404) {
    return new GithubNotFoundError(`${context} failed (404 not found)${detail}`);
  }
  if (res.status === 429 || (res.status === 403 && isRateLimited(res))) {
    const err = new GithubRateLimitError(`${context} rate-limited (${res.status})${detail}`);
    err.retryAfterMs = retryAfterMsFromHeaders(res.headers);
    return err;
  }
  return new Error(`${context} failed (HTTP ${res.status})${detail}`);
}

interface GraphqlError {
  type?: string;
  message?: string;
}

/** A GraphQL `errors[]` entry whose `type` indicates the node was not found. */
function graphqlNotFound(errors: GraphqlError[]): boolean {
  return errors.some((e) => e.type === "NOT_FOUND");
}

function bearerHeaders(auth: GithubAuth, extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    ...extra,
  };
}

interface GraphqlResult<T> {
  data: T;
  headers: Headers;
}

/**
 * POST a GraphQL query. Throws a typed error on HTTP failure, on transport
 * NOT_FOUND, or (when `notFoundMessage` is supplied) on a GraphQL-level
 * NOT_FOUND. Returns parsed `data` plus the response headers (for scope sniff).
 */
async function graphql<T>(
  auth: GithubAuth,
  query: string,
  variables: Record<string, unknown>,
  context: string,
  notFoundMessage?: string,
): Promise<GraphqlResult<T>> {
  assertGithubHost(GRAPHQL_URL);
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: bearerHeaders(auth, { "Content-Type": "application/json" }),
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw errorForStatus(res, await res.text(), context);
  }
  const json = (await res.json()) as { data?: T; errors?: GraphqlError[] };
  if (json.errors && json.errors.length > 0) {
    if (graphqlNotFound(json.errors)) {
      throw new GithubNotFoundError(
        notFoundMessage ?? `${context}: ${json.errors[0]?.message ?? "not found"}`,
      );
    }
    const messages = json.errors.map((e) => e.message ?? "unknown error").join("; ");
    throw new Error(`${context} GraphQL error: ${messages}`);
  }
  return { data: json.data as T, headers: res.headers };
}

/**
 * POST/PATCH a REST endpoint. `url` MUST resolve to the GitHub API origin —
 * the SSRF guard runs unconditionally because `url` may be derived from a
 * server-supplied (and thus user-influenceable) html_url.
 */
async function rest<T>(
  auth: GithubAuth,
  url: string,
  method: "POST" | "PATCH",
  body: unknown,
  context: string,
): Promise<T> {
  assertGithubHost(url);
  const res = await fetch(url, {
    method,
    headers: bearerHeaders(auth, { "Content-Type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw errorForStatus(res, await res.text(), context);
  }
  return (await res.json()) as T;
}

// ── Board URL parsing ──────────────────────────────────────────────────────

interface ParsedBoardUrl {
  ownerType: "organization" | "user";
  login: string;
  number: number;
}

/**
 * Parse `https://github.com/orgs/<org>/projects/<n>` or
 * `https://github.com/users/<user>/projects/<n>`. Only the parsed
 * owner/number are used downstream — the URL is NEVER fetched, so an attacker
 * cannot point the client at an arbitrary host through this input.
 */
function parseBoardUrl(boardUrl: string): ParsedBoardUrl {
  let parsed: URL;
  try {
    parsed = new URL(boardUrl);
  } catch {
    throw new GithubNotFoundError(`Not a valid GitHub Projects URL: ${boardUrl}`);
  }
  if (parsed.host !== "github.com") {
    throw new GithubNotFoundError(
      `Not a github.com Projects URL (host ${parsed.host}): ${boardUrl}`,
    );
  }
  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
  // Expect: [orgs|users, <login>, projects, <number>]
  const [scope, login, projects, numberRaw] = segments;
  if (segments.length !== 4 || projects !== "projects" || !login) {
    throw new GithubNotFoundError(
      `Unrecognized GitHub Projects URL shape: ${boardUrl} (expected /orgs/<org>/projects/<n> or /users/<user>/projects/<n>)`,
    );
  }
  const number = Number(numberRaw);
  if (!Number.isInteger(number) || number <= 0) {
    throw new GithubNotFoundError(`GitHub Projects URL has no valid project number: ${boardUrl}`);
  }
  if (scope === "orgs") return { ownerType: "organization", login, number };
  if (scope === "users") return { ownerType: "user", login, number };
  throw new GithubNotFoundError(
    `Unrecognized GitHub Projects owner scope "${scope}" in ${boardUrl} (expected "orgs" or "users")`,
  );
}

// ── GraphQL response shapes (narrow, only fields we read) ──────────────────

interface ProjectV2FieldOption {
  id: string;
  name: string;
}
interface ProjectV2Field {
  __typename?: string;
  id: string;
  name: string;
  options?: ProjectV2FieldOption[];
}
interface ProjectV2Node {
  id: string;
  title: string;
  field: ProjectV2Field | null;
}
interface ResolveBoardResponse {
  organization?: { projectV2: ProjectV2Node | null } | null;
  user?: { projectV2: ProjectV2Node | null } | null;
}

const RESOLVE_BOARD_QUERY = `
  query ResolveBoard($login: String!, $number: Int!) {
    OWNER(login: $login) {
      projectV2(number: $number) {
        id
        title
        field(name: "${STATUS_FIELD_NAME}") {
          ... on ProjectV2SingleSelectField {
            __typename
            id
            name
            options { id name }
          }
        }
      }
    }
  }
`;

interface ItemContent {
  __typename?: string;
  id?: string;
  title?: string;
  url?: string;
  updatedAt?: string;
}
interface ItemStatusValue {
  __typename?: string;
  optionId?: string | null;
  name?: string | null;
  field?: { name?: string } | null;
}
interface BoardItemNode {
  id: string;
  updatedAt: string;
  content: ItemContent | null;
  fieldValues: { nodes: ItemStatusValue[] };
}
interface FetchItemsResponse {
  node: {
    items: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: BoardItemNode[];
    };
  } | null;
}

interface CreateDraftResponse {
  addProjectV2DraftIssue: {
    projectItem: { id: string; content: { id: string; title: string } | null } | null;
  };
}

interface ItemContentResponse {
  node: {
    id: string;
    content: { __typename?: string; id?: string; title?: string; url?: string } | null;
  } | null;
}

interface StatusFieldIdResponse {
  node: { field: { id: string } | null } | null;
}

interface StatusOptionsResponse {
  node: { field: { id: string; options: ProjectV2FieldOption[] } | null } | null;
}

const FETCH_ITEMS_QUERY = `
  query FetchItems($boardId: ID!, $after: String) {
    node(id: $boardId) {
      ... on ProjectV2 {
        items(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            updatedAt
            content {
              __typename
              ... on Issue { id title url }
              ... on PullRequest { id title url }
              ... on DraftIssue { id title }
            }
            fieldValues(first: 20) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  __typename
                  optionId
                  name
                  field { ... on ProjectV2SingleSelectField { name } }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const VALIDATE_AUTH_QUERY = `
  query ValidateAuth($boardId: ID!) {
    node(id: $boardId) {
      ... on ProjectV2 { id }
    }
  }
`;

// Mutation / lookup documents used by the ticket methods. Hoisted to
// module-level consts (like the queries above) so they're parsed once at
// module load and Bun's --coverage attributes them consistently — an inline
// multi-line template literal inside a method body gets per-line DA records
// that drift across test shards (the documented "bun coverage attribution
// drift"), which would make the CODEOWNERS coverage gate flaky for this file.

const CREATE_DRAFT_MUTATION = `
  mutation CreateDraft($boardId: ID!, $title: String!, $body: String) {
    addProjectV2DraftIssue(input: { projectId: $boardId, title: $title, body: $body }) {
      projectItem {
        id
        content { ... on DraftIssue { id title } }
      }
    }
  }
`;

const ITEM_CONTENT_QUERY = `
  query ItemContent($itemId: ID!) {
    node(id: $itemId) {
      ... on ProjectV2Item {
        id
        content {
          __typename
          ... on Issue { id title url }
          ... on PullRequest { id title url }
          ... on DraftIssue { id title }
        }
      }
    }
  }
`;

const UPDATE_DRAFT_MUTATION = `
  mutation UpdateDraft($draftId: ID!, $title: String, $body: String) {
    updateProjectV2DraftIssue(input: { draftIssueId: $draftId, title: $title, body: $body }) {
      draftIssue { id title }
    }
  }
`;

const SET_STATUS_MUTATION = `
  mutation SetStatus($boardId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(
      input: {
        projectId: $boardId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }
    ) {
      projectV2Item { id }
    }
  }
`;

const ARCHIVE_ITEM_MUTATION = `
  mutation ArchiveItem($boardId: ID!, $itemId: ID!) {
    archiveProjectV2Item(input: { projectId: $boardId, itemId: $itemId }) {
      item { id }
    }
  }
`;

const ADD_COMMENT_MUTATION = `
  mutation AddComment($subjectId: ID!, $body: String!) {
    addComment(input: { subjectId: $subjectId, body: $body }) {
      commentEdge { node { id } }
    }
  }
`;

const STATUS_FIELD_ID_QUERY = `
  query StatusField($boardId: ID!) {
    node(id: $boardId) {
      ... on ProjectV2 {
        field(name: "${STATUS_FIELD_NAME}") {
          ... on ProjectV2SingleSelectField { id }
        }
      }
    }
  }
`;

const STATUS_OPTIONS_QUERY = `
  query StatusOptions($boardId: ID!) {
    node(id: $boardId) {
      ... on ProjectV2 {
        field(name: "${STATUS_FIELD_NAME}") {
          ... on ProjectV2SingleSelectField { id options { id name } }
        }
      }
    }
  }
`;

/** Extract the Status single-select option for one board item, if any. */
function extractStatus(item: BoardItemNode): { optionId: string | null; name: string | null } {
  for (const value of item.fieldValues.nodes) {
    if (value.field?.name?.toLowerCase() === STATUS_FIELD_NAME.toLowerCase()) {
      return { optionId: value.optionId ?? null, name: value.name ?? null };
    }
  }
  return { optionId: null, name: null };
}

class GithubClientImpl implements GithubClient {
  async resolveBoardFromUrl(boardUrl: string, auth: GithubAuth): Promise<GithubBoardRef> {
    const { ownerType, login, number } = parseBoardUrl(boardUrl);
    const query = RESOLVE_BOARD_QUERY.replace("OWNER", ownerType);
    const { data } = await graphql<ResolveBoardResponse>(
      auth,
      query,
      { login, number },
      "resolveBoardFromUrl",
      `GitHub Projects board not found: no ${ownerType} "${login}" project #${number}`,
    );
    const owner = ownerType === "organization" ? data.organization : data.user;
    const project = owner?.projectV2 ?? null;
    if (!project) {
      throw new GithubNotFoundError(
        `GitHub Projects board not found: no ${ownerType} "${login}" project #${number}`,
      );
    }
    const field = project.field;
    if (!field?.options) {
      throw new GithubNotFoundError(
        `GitHub Projects board "${project.title}" has no single-select "${STATUS_FIELD_NAME}" field`,
      );
    }
    const statusOptions: GithubStatusOption[] = field.options.map((o) => ({
      id: o.id,
      name: o.name,
    }));
    return {
      boardNodeId: project.id,
      title: project.title,
      ownerLogin: login,
      statusFieldId: field.id,
      statusOptions,
    };
  }

  async validateAuth(auth: GithubAuth, boardNodeId: string): Promise<GithubAuthValidation> {
    try {
      const { headers } = await graphql<{ node: { id: string } | null }>(
        auth,
        VALIDATE_AUTH_QUERY,
        { boardId: boardNodeId },
        "validateAuth",
      );
      const scopes = parseScopes(headers);
      return { ok: true, scopes, missingScopes: [] };
    } catch (err) {
      if (err instanceof GithubAuthError || err instanceof GithubNotFoundError) {
        // Likely missing the project scope on a classic PAT.
        return {
          ok: false,
          scopes: [],
          missingScopes: ["project", "read:project"],
          error: err.message,
        };
      }
      throw err;
    }
  }

  async fetchBoardItems(
    boardNodeId: string,
    auth: GithubAuth,
    cursor: Record<string, string> | null,
  ): Promise<GithubFetchPage> {
    const items: GithubBoardItem[] = [];
    const nextCursor: Record<string, string> = { ...(cursor ?? {}) };
    let after: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const result: GraphqlResult<FetchItemsResponse> = await graphql<FetchItemsResponse>(
        auth,
        FETCH_ITEMS_QUERY,
        { boardId: boardNodeId, after },
        "fetchBoardItems",
        `GitHub Projects board not found: ${boardNodeId}`,
      );
      const page = result.data.node;
      if (!page) {
        throw new GithubNotFoundError(`GitHub Projects board not found: ${boardNodeId}`);
      }
      for (const node of page.items.nodes) {
        const status = extractStatus(node);
        const item: GithubBoardItem = {
          itemNodeId: node.id,
          contentNodeId: node.content?.id ?? null,
          title: node.content?.title ?? "(untitled)",
          url: node.content?.url ?? null,
          statusOptionId: status.optionId,
          statusName: status.name,
          updatedAt: node.updatedAt,
        };
        items.push(item);
        nextCursor[item.itemNodeId] = item.updatedAt;
      }
      hasNextPage = page.items.pageInfo.hasNextPage;
      after = page.items.pageInfo.endCursor;
    }

    return { items, cursor: nextCursor };
  }

  async createIssueOnBoard(
    boardNodeId: string,
    auth: GithubAuth,
    input: GithubCreateTicketInput,
  ): Promise<GithubTicketRef> {
    // Create a DRAFT issue directly on the project so the client stays
    // repo-agnostic and GraphQL-only (no repo needs to be picked for v1).
    const { data } = await graphql<CreateDraftResponse>(
      auth,
      CREATE_DRAFT_MUTATION,
      { boardId: boardNodeId, title: input.title, body: input.body ?? "" },
      "createIssueOnBoard",
    );
    const projectItem = data.addProjectV2DraftIssue.projectItem;
    if (!projectItem) {
      throw new GithubNotFoundError(
        `createIssueOnBoard: board ${boardNodeId} did not return a created item`,
      );
    }
    const ref: GithubTicketRef = {
      itemNodeId: projectItem.id,
      contentNodeId: projectItem.content?.id ?? null,
      url: null,
      title: projectItem.content?.title ?? input.title,
    };
    if (input.statusName) {
      await this.#setStatusByName(boardNodeId, auth, projectItem.id, input.statusName);
    }
    return ref;
  }

  async updateItem(
    boardNodeId: string,
    auth: GithubAuth,
    input: GithubUpdateTicketInput,
  ): Promise<GithubTicketRef> {
    // Resolve the item's content node so we can route the title/body update to
    // the right surface (REST for a real issue/PR, GraphQL for a draft).
    const { data } = await graphql<ItemContentResponse>(
      auth,
      ITEM_CONTENT_QUERY,
      { itemId: input.itemNodeId },
      "updateItem",
      `updateItem: project item not found: ${input.itemNodeId}`,
    );
    const node = data.node;
    if (!node) {
      throw new GithubNotFoundError(`updateItem: project item not found: ${input.itemNodeId}`);
    }
    const content = node.content;
    let title = content?.title ?? "";
    const url = content?.url ?? null;

    if (input.title !== undefined || input.body !== undefined) {
      if (content?.__typename === "DraftIssue") {
        await graphql(
          auth,
          UPDATE_DRAFT_MUTATION,
          { draftId: content.id, title: input.title, body: input.body },
          "updateItem(draft)",
        );
        if (input.title !== undefined) title = input.title;
      } else if (content?.url) {
        // REST PATCH on a real issue/PR. The api URL is derived from the
        // server-supplied html_url; `rest` re-asserts the api.github.com origin.
        const issueApiUrl = restIssueApiUrlFromHtmlUrl(content.url);
        const patched = await rest<{ title: string; html_url: string }>(
          auth,
          issueApiUrl,
          "PATCH",
          {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.body !== undefined ? { body: input.body } : {}),
          },
          "updateItem(issue)",
        );
        title = patched.title;
      }
    }

    if (input.statusName) {
      await this.#setStatusByName(boardNodeId, auth, input.itemNodeId, input.statusName);
    }

    return {
      itemNodeId: input.itemNodeId,
      contentNodeId: content?.id ?? null,
      url,
      title,
    };
  }

  async setItemStatus(
    boardNodeId: string,
    auth: GithubAuth,
    itemNodeId: string,
    statusOptionId: string,
  ): Promise<void> {
    const fieldId = await this.#resolveStatusFieldId(boardNodeId, auth);
    await graphql(
      auth,
      SET_STATUS_MUTATION,
      { boardId: boardNodeId, itemId: itemNodeId, fieldId, optionId: statusOptionId },
      "setItemStatus",
    );
  }

  async archiveItem(boardNodeId: string, auth: GithubAuth, itemNodeId: string): Promise<void> {
    await graphql(
      auth,
      ARCHIVE_ITEM_MUTATION,
      { boardId: boardNodeId, itemId: itemNodeId },
      "archiveItem",
    );
  }

  async addComment(auth: GithubAuth, contentNodeId: string, body: string): Promise<void> {
    await graphql(auth, ADD_COMMENT_MUTATION, { subjectId: contentNodeId, body }, "addComment");
  }

  // ── private helpers ──────────────────────────────────────────────────────

  /** Resolve the board's Status single-select field id (for status mutations). */
  async #resolveStatusFieldId(boardNodeId: string, auth: GithubAuth): Promise<string> {
    const { data } = await graphql<StatusFieldIdResponse>(
      auth,
      STATUS_FIELD_ID_QUERY,
      { boardId: boardNodeId },
      "resolveStatusField",
      `Board ${boardNodeId} not found while resolving Status field`,
    );
    const fieldId = data.node?.field?.id;
    if (!fieldId) {
      throw new GithubNotFoundError(
        `Board ${boardNodeId} has no single-select "${STATUS_FIELD_NAME}" field`,
      );
    }
    return fieldId;
  }

  /** Resolve a Status option by name (case-insensitive) and apply it. */
  async #setStatusByName(
    boardNodeId: string,
    auth: GithubAuth,
    itemNodeId: string,
    statusName: string,
  ): Promise<void> {
    const { data } = await graphql<StatusOptionsResponse>(
      auth,
      STATUS_OPTIONS_QUERY,
      { boardId: boardNodeId },
      "setStatusByName",
      `Board ${boardNodeId} not found while resolving Status options`,
    );
    const field = data.node?.field;
    if (!field) {
      throw new GithubNotFoundError(
        `Board ${boardNodeId} has no single-select "${STATUS_FIELD_NAME}" field`,
      );
    }
    const option = field.options.find((o) => o.name.toLowerCase() === statusName.toLowerCase());
    if (!option) {
      throw new GithubNotFoundError(
        `Board ${boardNodeId} has no "${STATUS_FIELD_NAME}" option named "${statusName}"`,
      );
    }
    await this.setItemStatus(boardNodeId, auth, itemNodeId, option.id);
  }
}

/**
 * Map an issue/PR html_url (`https://github.com/{owner}/{repo}/issues/{n}`) to
 * its REST API URL. Only a well-formed `github.com` URL is rewritten to the
 * api.github.com REST path; anything else (foreign host OR an unparseable
 * string) is returned verbatim so the caller's `assertGithubHost` rejects it
 * (SSRF guard) rather than silently trusting attacker-supplied input.
 */
function restIssueApiUrlFromHtmlUrl(htmlUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(htmlUrl);
  } catch {
    return htmlUrl; // malformed → assertGithubHost will refuse it
  }
  if (parsed.host !== "github.com") {
    return htmlUrl; // foreign host → assertGithubHost will refuse it
  }
  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
  // [owner, repo, issues|pull, number]
  const [owner, repo, , number] = segments;
  if (segments.length < 4 || !owner || !repo || !number) {
    throw new GithubNotFoundError(`Cannot derive REST path from URL: ${htmlUrl}`);
  }
  return `${GITHUB_API_ORIGIN}/repos/${owner}/${repo}/issues/${number}`;
}

export function createGithubClient(): GithubClient {
  return new GithubClientImpl();
}
