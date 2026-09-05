# Browser extensions

Use `@ezcorp/sdk/browser` for browser calls. See the [client reference](../../packages/@ezcorp/sdk/src/browser/README.md). Do not copy the transport or use direct API calls from the extension frame.

Add `ezcorp.browser.json` to the source workspace:

```json
{
  "schemaVersion": 1,
  "entrypoint": "app/main.js",
  "html": "app/index.html",
  "styles": ["app/style.css"],
  "tools": ["lookup", "save"]
}
```

Each tool must also exist in the release manifest. The fixed, isolated compiler bundles local dependencies without network access. It does not run extension build plugins or package scripts. Browser output is part of the sealed release; source files cannot supply `.runner` artifacts.

Open `/extensions/<name>/preview?conversationId=<owned-id>`. Without a conversation, the trusted host asks the user to select one or create one in an allowed project. The child cannot choose its own user or conversation.

The frame has an opaque origin. It cannot read host cookies, use direct network requests, or access the camera. A private message port permits only the sealed tool list. The host checks the session, conversation ownership, and exact active release and grants. Navigation or closure ends the port. A changed release requires a new preview.

For camera access, call `camera.start`. The trusted host asks for consent and owns Start and Stop controls. It sends bounded frames through the port. Device access does not become an extension permission.

The trusted host prepares a single-use request receipt before dispatch. Its identity binds the user, installation, release, conversation, tool, and input. A second host cannot claim it again. Shared PostgreSQL is required when hosts serve the same installation.

Cancellation uses an explicit authenticated request, not only a disconnected HTTP connection. Once recorded, cancellation stops new capability calls and closes the invocation worker. Database effects check the receipt inside their transaction. A failed cancellation request produces a warning; the invocation deadline remains the final bound. Cancellation does not undo effects already admitted or committed. Do not retry unless the outcome is known to be safe.

Request storage has per-user and global limits. Old receipts become eligible for deletion after 24 hours; preparation performs bounded cleanup. This is not a scheduled deletion guarantee. An absent receipt cannot be claimed or replayed.
