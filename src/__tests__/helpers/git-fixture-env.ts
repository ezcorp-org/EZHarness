/** Keep disposable Git repositories independent of a caller's hook context. */
export function fixtureGitEnv(ambient: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(ambient)) {
    if (!name.startsWith("GIT_") && value !== undefined) env[name] = value;
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  return env;
}
