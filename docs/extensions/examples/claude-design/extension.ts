import { createRuntimeExtension, serve } from "@ezcorp/sdk/v4";
import manifest from "./ezcorp.config";

const extension = await createRuntimeExtension({
  manifest,
  register: async () => { await import("./index"); },
});

await serve(extension);
