import { mcpRouteTests } from "./helpers/mcp-stage-route-tests";

const { POST } = await import("../routes/api/mcp-servers/[id]/refresh/+server");
mcpRouteTests("refresh", POST);
