import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "github-stats",
  version: "1.0.0",
  description: "Fetch GitHub repository and user statistics via the GitHub API",
  author: {
    name: "EZCorp",
  },
  entrypoint: "./index.ts",
  tools: [
    {
      name: "repo-stats",
      description: "Get repository statistics (stars, forks, issues, language)",
      inputSchema: {
        type: "object",
        properties: {
          owner: {
            type: "string",
            description: "Repository owner",
          },
          repo: {
            type: "string",
            description: "Repository name",
          },
        },
        required: ["owner", "repo"],
      },
    },
    {
      name: "user-profile",
      description: "Get a GitHub user profile",
      inputSchema: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description: "GitHub username",
          },
        },
        required: ["username"],
      },
    },
    {
      name: "repo-languages",
      description: "Get the language breakdown for a repository",
      inputSchema: {
        type: "object",
        properties: {
          owner: {
            type: "string",
            description: "Repository owner",
          },
          repo: {
            type: "string",
            description: "Repository name",
          },
        },
        required: ["owner", "repo"],
      },
    },
  ],
  permissions: {
    network: ["api.github.com"],
    env: ["GITHUB_TOKEN"],
  },
  resources: {
    memory: "256MB",
  },
});
