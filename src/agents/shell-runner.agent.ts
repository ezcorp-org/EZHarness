import type { AgentDefinition } from "../types";

export default {
  name: "shell-runner",
  description: "Run shell commands",
  capabilities: ["shell"],
  inputSchema: {
    command: { type: "string", label: "Command", description: "Shell command to run", required: true },
    cwd: { type: "file-path", label: "Working Directory", description: "Directory to run in" },
  },

  async execute(ctx) {
    const { command, cwd } = ctx.input as { command?: string; cwd?: string };

    if (!command) {
      return { success: false, output: null, error: "Provide 'command' in input" };
    }

    ctx.log(`Running: ${command}`);
    const { stdout, stderr, exitCode } = await ctx.shell.run(command, {
      ...(cwd ? { cwd } : {}),
    });

    return { success: exitCode === 0, output: { stdout, stderr, exitCode } };
  },
} satisfies AgentDefinition;
