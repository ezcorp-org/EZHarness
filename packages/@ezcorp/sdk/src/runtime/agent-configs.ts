// ── AgentConfigs — typed client for ezcorp/agent-configs reverse RPC ──
//
// Read-only access to the calling user's agent configs. The host
// (`src/extensions/agent-configs-handler.ts`) returns a minimum-information
// summary — id, name, description, isTeam, ownerUserId — and never the
// full prompt / references / extensions. Every call is permission-gated
// on `agentConfig: "read"` and user-scoped to the installing user.
//
// No client-side retry on -32029: the 50 ops/sec budget is a sane
// ceiling for a read API. Callers that hit it are doing something wrong
// and should back off explicitly.

import { getChannel } from "./channel";

export interface AgentConfigSummary {
  id: string;
  name: string;
  description: string;
  isTeam: boolean;
  ownerUserId: string | null;
}

export class AgentConfigs {
  async list(): Promise<AgentConfigSummary[]> {
    const result = await getChannel().request<{
      v: 1;
      configs: AgentConfigSummary[];
    }>("ezcorp/agent-configs", { v: 1, action: "list" });
    return result.configs;
  }

  async resolve(idOrName: string): Promise<AgentConfigSummary | null> {
    const result = await getChannel().request<{
      v: 1;
      config: AgentConfigSummary | null;
    }>("ezcorp/agent-configs", { v: 1, action: "resolve", idOrName });
    return result.config;
  }
}
