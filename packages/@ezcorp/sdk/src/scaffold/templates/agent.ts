import { templateManifest, templateEntrypoint, templateTest, templateReadme } from "./tool";

export function agentManifest(name: string, description: string): string { return templateManifest("agent", name, description); }
export function agentEntrypoint(name: string, _description: string): string { return templateEntrypoint("agent", name); }
export function agentTest(name: string, _description: string): string { return templateTest("agent", name); }
export function agentReadme(name: string, description: string): string { return templateReadme("agent", name, description); }
