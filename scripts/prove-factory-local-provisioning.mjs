import { createSign, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { SQL } from "bun";
import { LocalFactoryProvisioner } from "../src/factory/provisioning/local.ts";

const authDir = process.env.EZCORP_FACTORY_TEMPORAL_AUTH_DIR;
const productAdminUrl = process.env.FACTORY_TEST_POSTGRES_URL;
const ordinaryConfigPath = process.env.EZCORP_FACTORY_ORDINARY_CONFIG_PATH;
const archiveConfigPath = process.env.EZCORP_FACTORY_ARCHIVE_CONFIG_PATH;
if (!authDir || !productAdminUrl || !ordinaryConfigPath || !archiveConfigPath) throw new Error("Factory local proof references are required.");
const proofRoot = process.env.EZCORP_FACTORY_PROOF_ROOT ?? "/run/user/1001/ezcorp-factory-provisioning";
await mkdir(proofRoot, { recursive: true, mode: 0o700 }); await chmod(proofRoot, 0o700);
const clientModule = await import("../packages/@ezcorp/factory-orchestrator/node_modules/@temporalio/client/lib/index.js");
const bytes = async name => new Uint8Array(await readFile(join(authDir, name)));
const token = async (subject, permissions) => {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "RS256", kid: "factory-local", typ: "JWT" })}.${encode({ sub: subject, iss: "ezcorp-factory-local", aud: "ezcorp-temporal", permissions, exp: Math.floor(Date.now() / 1000) + 300 })}`;
  const signer = createSign("RSA-SHA256"); signer.update(input); signer.end();
  return `${input}.${signer.sign(await readFile(join(authDir, "jwt.key"))).toString("base64url")}`;
};
const connection = async (identity, permissions) => clientModule.Connection.connect({
  address: "127.0.0.1:17233",
  tls: { serverNameOverride: "temporal.local", serverRootCACertificate: await bytes("ca.crt"), clientCertPair: { crt: await bytes(`${identity}.crt`), key: await bytes(`${identity}.key`) } },
  metadata: { authorization: `Bearer ${await token(identity, permissions)}` },
});
const passwordPath = join(proofRoot, "control-password");
let controlPassword;
try { controlPassword = (await readFile(passwordPath, "utf8")).trim(); } catch { controlPassword = randomBytes(32).toString("base64url"); await writeFile(passwordPath, `${controlPassword}\n`, { mode: 0o600 }); }
const controlDatabase = "factory_control_local";
const controlRole = "factory_control_local_role";
const admin = new SQL(productAdminUrl, { max: 1 });
const role = (await admin`SELECT 1 FROM pg_roles WHERE rolname = ${controlRole}`)[0];
if (!role) await admin.unsafe(`CREATE ROLE "${controlRole}" LOGIN PASSWORD '${controlPassword}'`);
const database = (await admin`SELECT 1 FROM pg_database WHERE datname = ${controlDatabase}`)[0];
if (!database) await admin.unsafe(`CREATE DATABASE "${controlDatabase}" OWNER "${controlRole}"`);
await admin.close();
const controlUrl = new URL(productAdminUrl); controlUrl.pathname = `/${controlDatabase}`; controlUrl.username = controlRole; controlUrl.password = controlPassword;
const temporal = {
  async create({ tenantId, namespace, secretDirectory }) {
    const control = await connection("factory-control", ["admin:temporal-system"]);
    try { await control.workflowService.registerNamespace({ namespace, workflowExecutionRetentionPeriod: { seconds: 86_400 } }); }
    catch (error) { if (error.code !== 6) throw error; }
    await control.close();
    const tenantToken = await token(tenantId, [`admin:${namespace}`]);
    const tokenPath = join(secretDirectory, "temporal-token");
    try { await writeFile(tokenPath, `${tenantToken}\n`, { mode: 0o600, flag: "wx" }); } catch { /* recovery retains its original bundle */ }
    await chmod(tokenPath, 0o600);
    await writeFile(join(secretDirectory, "temporal.json"), `${JSON.stringify({ namespace, certificatePath: join(authDir, `${tenantId}.crt`), privateKeyPath: join(authDir, `${tenantId}.key`), tokenPath })}\n`, { mode: 0o600 });
  },
};
const provisioner = new LocalFactoryProvisioner({ controlDatabaseUrl: controlUrl.toString(), productDatabaseAdminUrl: productAdminUrl, ordinaryConfigPath, archiveConfigPath, secretsRoot: join(proofRoot, "installations"), temporal });
const tenants = Array.from({ length: 10 }, (_, index) => `tenant-${String(index + 1).padStart(2, "0")}`);
const first = [];
for (const tenantId of tenants) first.push(await provisioner.provision({ tenantId, hostname: `${tenantId}.factory.local`, administratorEmail: `${tenantId}@example.test` }));
const replay = [];
for (const tenantId of tenants) replay.push(await provisioner.provision({ tenantId, hostname: `${tenantId}.factory.local`, administratorEmail: `${tenantId}@example.test` }));
if (first.some((installation, index) => installation.installationId !== replay[index].installationId)) throw new Error("Provisioning replay changed an installation identity.");
const control = new SQL(controlUrl.toString(), { max: 1 });
const rows = await control`SELECT tenant_id, product_database, product_role, temporal_namespace, state, secret_bundle_path FROM factory_installations ORDER BY tenant_id`;
if (rows.length !== 10 || rows.some(row => row.state !== "ready")) throw new Error("Control plane did not record ten ready installations.");
await control.close(); await provisioner.close();
console.log(`provisioned ${rows.length} isolated installations with replay-safe control state`);
console.log(`secret bundle root reference: ${basename(proofRoot)}/installations`);
