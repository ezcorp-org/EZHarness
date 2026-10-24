import { serve } from "@ezcorp/sdk/v4";
import { createIncusExtension, resolveHostIncusInvocationRuntime } from "./index";

await serve(createIncusExtension(resolveHostIncusInvocationRuntime));
