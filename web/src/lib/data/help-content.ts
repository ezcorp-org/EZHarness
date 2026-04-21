/**
 * Centralized help tooltip content.
 * All user-facing tooltip text lives here -- components reference by key.
 */
export const helpContent: Record<string, string> = {
	// Agent editor fields
	"agent.system-prompt":
		"The system prompt defines your agent's personality and behavior. It is sent as the first instruction before every conversation.",
	"agent.model":
		"Choose a specific model to override the default. Faster models are cheaper and lower-latency; more powerful models handle complex tasks better.",
	"agent.extensions":
		"Extensions give your agent access to external tools and APIs. Attach an extension to let the agent call its tools during conversations.",
	"agent.variables":
		"Override shared variables for this agent. Values set here take priority over the extension-level defaults.",

	// Extension/provider settings
	"settings.providers":
		"API keys for LLM providers (Anthropic, OpenAI, Google). Keys are encrypted at rest and used to authenticate requests to each provider.",
	"settings.extensions":
		"Manage installed extensions. Extensions add tools that agents and inline invocations can use during conversations.",
	"extension.variables":
		"Shared variables are auto-populated into every extension that declares them with the x-shared prefix. Set values once here and all extensions receive them.",

	// Memory/knowledge base
	"memory.overview":
		"Memories are facts automatically extracted from your conversations. They persist across chats so the AI remembers important context about your projects.",
	"knowledge.overview":
		"The knowledge base stores documents you upload. During conversations the AI searches these files to ground its answers in your own data.",

	// Chat features
	"chat.mentions":
		"Type a trigger to open a searchable popover, then Enter to insert:\n\n/  Slash commands (/review, /commit…)\n@  Project files & folders\n!  Agents, extensions, teams\n\nEach inserts a structured chip you can delete atomically. Arg text after a /command is substituted into its body as $ARGUMENTS.",
	"chat.inline-tools":
		"Inline tools run extension actions directly in the chat. Click an extension mention chip to pick a tool and fill in its arguments.",
	"chat.sub-conversations":
		"Sub-conversations are scoped side-threads within a chat. They let you explore a tangent without polluting the main conversation history.",
	"chat.diff-panel":
		"The diff summary panel collects all file changes from the conversation into one view. Toggle between split and unified diff formats.",
};
