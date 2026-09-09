import { createRuntimeExtension, serve } from "@ezcorp/sdk/v4";
import manifest from "./ezcorp.config";

const extension = await createRuntimeExtension({
  manifest,
  register: () => {},
});

await serve(extension);
