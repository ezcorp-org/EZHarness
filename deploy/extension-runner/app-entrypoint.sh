#!/bin/sh
set -eu

# Check from the app's own UID and mounts, through the normal credential reader.
# Never print a credential or a raw connection error. Bound stalled gateways too.
bun -e '
import { getConfiguredExtensionRunner } from "./src/extensions/runner-connection.ts";
import { getExtensionRunnerMode } from "./src/extensions/runner-mode.ts";
const fail = () => {
  console.error("Extension runner is not ready. Check its service, socket, credential and application UID. See deploy/extension-runner/README.md.");
  process.exit(1);
};
const timeout = setTimeout(fail, 15000);
try {
  if (getExtensionRunnerMode() === "isolated") {
    const result = await getConfiguredExtensionRunner().inspect("app-startup-probe");
    if (result.state !== "unknown") fail();
  }
  clearTimeout(timeout);
} catch { fail(); }
'
exec "$@"
