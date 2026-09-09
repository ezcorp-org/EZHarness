import { createRuntimeExtension, serve } from "@ezcorp/sdk/v4";
import manifest from "./ezcorp.config";

const extension = await createRuntimeExtension({
  manifest,
  register: async () => {
    const implementation = await import("./index");
    await implementation.start();
  },
});

await serve(extension);
