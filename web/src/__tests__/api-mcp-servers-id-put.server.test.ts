import { mcpRouteTests } from "./helpers/mcp-stage-route-tests";

const { PUT } = await import("../routes/api/mcp-servers/[id]/+server");
mcpRouteTests("update", PUT);
