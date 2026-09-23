import { eq, ne, like, or, sql } from "drizzle-orm";
import { getDb } from "../connection";
import { settings, conversations, extensions, agentConfigs } from "../schema";
import { LLM_PROVIDERS, type LlmProviderSpec } from "../../runtime/routing/llm-providers";

export interface QuickstartSteps {
  provider: boolean;
  chat: boolean;
  extension: boolean;
  agent: boolean;
}

/**
 * Has anyone CONFIGURED a provider credential (a stored API key or OAuth)?
 *
 * This is deliberately narrower than "can this install chat" — see
 * {@link hasUsableProvider}. Onboarding asks this question: its "a provider is
 * already connected" notice and the skip flow both mean a credential someone
 * set up, and a keyless tier is not that.
 */
export async function hasAnyProvider(): Promise<boolean> {
  const rows = await getDb()
    .select({ v: sql`1` })
    .from(settings)
    .where(or(like(settings.key, "provider:apiKey:%"), like(settings.key, "provider:oauth:%")))
    .limit(1);
  return rows.length > 0;
}

/**
 * Pure: does any provider in `specs` answer with nothing configured?
 * Takes the table as a parameter so the no-keyless world stays testable
 * without editing the real provider list.
 */
export function anyKeylessProvider(specs: readonly LlmProviderSpec[]): boolean {
  return specs.some((spec) => spec.keylessFreeTier);
}

/**
 * Can this install send a chat message at all?
 *
 * Until the Kilo gateway landed (#155) this was the same question as
 * {@link hasAnyProvider}. It no longer is: Kilo's free models answer an
 * anonymous request (measured, see runtime/routing/kilo-catalog.ts), and
 * routing sends a keyless install there by construction. So a fresh install
 * with no key CAN chat — and the chat banner that reads this answer used to
 * tell that user to "add an API key … to send your first message", on every
 * fresh install, falsely.
 *
 * This is the same rule web/src/lib/server/provider-availability.ts applies
 * to the model picker, which already treats a keyless provider as available.
 */
export async function hasUsableProvider(
  specs: readonly LlmProviderSpec[] = LLM_PROVIDERS,
): Promise<boolean> {
  return anyKeylessProvider(specs) || (await hasAnyProvider());
}

export async function getQuickstartSteps(userId: string): Promise<QuickstartSteps> {
  const db = getDb();
  const [providerUsable, chatRow, extensionRow, agentRow] = await Promise.all([
    // "Can this user chat", not "did someone store a key" — this step drives
    // the chat banner and the checklist, both of which mean the former.
    hasUsableProvider(),
    db
      .select({ v: sql`1` })
      .from(conversations)
      .where(
        sql`${conversations.userId} = ${userId} AND ${conversations.parentConversationId} IS NULL`,
      )
      .limit(1),
    db
      .select({ v: sql`1` })
      .from(extensions)
      .where(ne(extensions.name, "builtin-tools"))
      .limit(1),
    db
      .select({ v: sql`1` })
      .from(agentConfigs)
      .where(eq(agentConfigs.userId, userId))
      .limit(1),
  ]);
  return {
    provider: providerUsable,
    chat: chatRow.length > 0,
    extension: extensionRow.length > 0,
    agent: agentRow.length > 0,
  };
}
