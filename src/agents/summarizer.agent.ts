import type { AgentDefinition } from "../types";

export default {
  name: "summarizer",
  description: "Summarize text using an LLM",
  capabilities: ["llm", "file"],
  inputSchema: {
    text: { type: "text", label: "Text", description: "Text to summarize", required: true },
    file: { type: "file-path", label: "File", description: "Or read from file path" },
    provider: { type: "select", label: "Provider", options: ["anthropic", "google", "openai", "openrouter"], default: "anthropic" },
    model: { type: "string", label: "Model", description: "Override model name" },
  },

  async execute(ctx) {
    const { text, file, provider, model } = ctx.input as {
      text?: string;
      file?: string;
      provider?: string;
      model?: string;
    };

    let content: string;

    if (text) {
      ctx.log("Using provided text input");
      content = text;
    } else if (file) {
      ctx.log(`Reading file: ${file}`);
      content = await ctx.file.read(file as string);
    } else {
      return { success: false, output: null, error: "Provide 'text' or 'file' in input" };
    }

    ctx.log("Requesting summary from LLM");
    const response = await ctx.llm.complete(
      [{ role: "user", content }],
      {
        system: "You are a summarizer. Provide a concise summary of the given text.",
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      },
    );

    ctx.log("Summary complete");
    return { success: true, output: { summary: response.text } };
  },
} satisfies AgentDefinition;
