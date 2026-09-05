# Browser client

Import `createCanvasBridge` from `@ezcorp/sdk/browser` in a sealed extension
browser entrypoint. Do not import the runtime or v4 worker entrypoint into the
browser. This module has no Node, stdin or dynamic-code dependencies.

```ts
import { createCanvasBridge } from "@ezcorp/sdk/browser";

const bridge = createCanvasBridge(window);
const controller = new AbortController();
const result = await bridge.request("tool.invoke", {
  toolName: "save_card",
  input: { title: "Example" },
}, { signal: controller.signal, timeoutMs: 30_000 });
```

The host supplies a nonce to the opaque sandbox frame. The client connects one
private MessagePort to the exact host origin. Responses do not use a window
message listener. JSON requests are limited to 256 KiB, responses to 1 MiB, and
pending requests to 32. Tool and stop requests expire within 60 seconds. Camera
start requests can wait up to five minutes for trusted host consent.

`subscribeCamera(listener)` returns an unsubscribe function. It receives bounded
JPEG camera frames, a camera-stopped event, or `ezcorp.canvas.closed` when the
host revokes the connection. The host owns camera access and
consent; the extension does not receive a browser camera grant.

`close()` rejects pending requests and sends a host close message. It retains the
port until the host confirms closure, with a one-second drain limit, so immediate
port disposal cannot discard the close message. Page hide calls it automatically.
Aborting a request sends cancellation for
its exact request ID. Cancellation cannot undo effects that already committed.
The host must support the canvas cancel and close messages to stop its work.
