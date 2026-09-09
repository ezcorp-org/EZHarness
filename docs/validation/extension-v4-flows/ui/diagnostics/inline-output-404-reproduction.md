# Inline output 404 reproduction

Before the fix, the exact real-browser lifecycle command at source SHA `308262f9` completed the user flow but failed its final client diagnostic assertion. It recorded two browser console errors: `Failed to load resource: the server responded with a status of 404 (Not Found)`.

The local raw trace identified both requests as `GET /api/tool-calls/<client-invocation-id>/output`, one for each live inline extension call. The trace is intentionally not committed because it contains session cookies. The event already carried the full tool output, while the client invocation id had no persisted `tool_calls` row. The fixed lifecycle replay has an empty client diagnostic attachment.
