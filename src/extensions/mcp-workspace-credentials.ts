import { sql } from "drizzle-orm";
import { canonicalJson } from "@ezcorp/extension-contract";
import { getDb } from "../db/connection";
import { encryptWithAad, decryptWithAad } from "../providers/encryption";
import { applyMcpSecretBlob, buildMcpSecretBlob, parseMcpSecretBlob, redactMcpServer, serializeMcpSecretBlob } from "./mcp-secret-redaction";
import type { McpServerDefinition } from "./types";

function credentialBinding(installationId: string, workspaceId: string, server: McpServerDefinition): string {
  return canonicalJson(["mcp-v4", installationId, workspaceId, redactMcpServer(server)]);
}

export async function persistMcpWorkspaceCredentials(installationId: string, workspaceId: string, server: McpServerDefinition): Promise<void> {
  const blob = buildMcpSecretBlob(server);
  if (!blob) return;
  const ciphertext = encryptWithAad(serializeMcpSecretBlob(blob), credentialBinding(installationId, workspaceId, server));
  await getDb().execute(sql`INSERT INTO extension_mcp_credentials (installation_id, workspace_id, ciphertext) VALUES (${installationId}, ${workspaceId}, ${ciphertext})`);
}

export async function rehydrateMcpWorkspaceCredentials(installationId: string, workspaceId: string, server: McpServerDefinition): Promise<McpServerDefinition> {
  const rows = await getDb().execute(sql`SELECT ciphertext FROM extension_mcp_credentials WHERE installation_id = ${installationId} AND workspace_id = ${workspaceId}`);
  const redacted = redactMcpServer(server);
  if (!rows.rows[0]) return redacted;
  const plaintext = decryptWithAad(String(rows.rows[0].ciphertext), credentialBinding(installationId, workspaceId, server));
  const blob = parseMcpSecretBlob(plaintext);
  if (!blob) throw new Error("Invalid MCP workspace credentials");
  return applyMcpSecretBlob(redacted, blob);
}

export async function deleteMcpWorkspaceCredentials(installationId: string): Promise<void> {
  await getDb().execute(sql`DELETE FROM extension_mcp_credentials WHERE installation_id = ${installationId}`);
}
