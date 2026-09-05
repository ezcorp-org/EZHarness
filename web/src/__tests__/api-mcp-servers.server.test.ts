import { mcpRouteTests } from "./helpers/mcp-stage-route-tests";

const { POST } = await import("../routes/api/mcp-servers/+server");
mcpRouteTests("install", POST);
