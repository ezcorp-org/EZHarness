import { createRuntimeExtension, serve } from "@ezcorp/sdk/v4";
import manifest from "./ezcorp.config";

await serve(await createRuntimeExtension({
  manifest,
  register: async () => { const implementation = await import("./index"); implementation.start(); },
}));
