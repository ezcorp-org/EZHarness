import { resolve, relative } from "path";

export function validatePath(projectPath: string, relativePath: string): string {
  const resolved = resolve(projectPath, relativePath);
  const rel = relative(projectPath, resolved);
  if (rel.startsWith("..") || resolve(resolved) !== resolved && rel.startsWith("..")) {
    throw new Error("Path traversal detected: path must stay within the project directory");
  }
  if (!resolved.startsWith(projectPath)) {
    throw new Error("Path traversal detected: path must stay within the project directory");
  }
  return resolved;
}

export function validateTimeout(timeout?: number, max: number = 600000): number {
  const defaultTimeout = 120000;
  if (timeout === undefined || timeout === null) return defaultTimeout;
  return Math.max(1000, Math.min(timeout, max));
}
