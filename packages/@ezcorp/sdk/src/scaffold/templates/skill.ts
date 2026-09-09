import { templateManifest, templateEntrypoint, templateTest, templateReadme } from "./tool";

export function skillManifest(name: string, description: string): string { return templateManifest("skill", name, description); }
export function skillEntrypoint(name: string, _description: string): string { return templateEntrypoint("skill", name); }
export function skillTest(name: string, _description: string): string { return templateTest("skill", name); }
export function skillReadme(name: string, description: string): string { return templateReadme("skill", name, description); }
