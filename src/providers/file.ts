import type { FileProvider } from "../types";

export function createFileProvider(): FileProvider {
  return {
    async read(path: string): Promise<string> {
      return Bun.file(path).text();
    },

    async write(path: string, content: string): Promise<void> {
      await Bun.write(path, content);
    },

    async exists(path: string): Promise<boolean> {
      return Bun.file(path).exists();
    },
  };
}
