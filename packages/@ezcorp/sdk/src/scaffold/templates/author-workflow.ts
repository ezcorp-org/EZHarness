export function authorWorkflow(includeDevServer = false): string {
  const development = includeDevServer
    ? `
## Development

\`\`\`bash
bun "$EZCORP_HOST/src/cli.ts" ext dev "$PWD"
\`\`\`
`
    : "";

  return `## Verify and install

From this extension directory, install dependencies, then point \`EZCORP_HOST\`
at a checkout of the EZCorp host. There is no globally installed \`ezcorp\`
binary.

\`\`\`bash
bun install
export EZCORP_HOST=/absolute/path/to/EZHarness
bun test
bun "$EZCORP_HOST/src/cli.ts" ext verify "$PWD"
bun "$EZCORP_HOST/src/cli.ts" ext install "$PWD"
\`\`\`
${development}`;
}
