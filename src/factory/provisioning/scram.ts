/**
 * A PostgreSQL SCRAM-SHA-256 password verifier, computed on this side.
 *
 * `CREATE ROLE ... PASSWORD '<plaintext>'` puts the password in the statement
 * text, and statement text reaches the server log (`log_statement`), error
 * context, and `pg_stat_statements`. The server accepts a verifier in the same
 * place and stores it as is, so only the verifier ever crosses the wire. The
 * format is PostgreSQL's (RFC 5802 and RFC 7677):
 * `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`.
 *
 * The server normalises a password with SASLprep before it derives the key.
 * SASLprep leaves printable ASCII unchanged, so the verifier accepts only
 * printable ASCII and needs no normaliser of its own. Generated passwords are
 * base64url, which is inside that set.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { FactoryProvisioningError } from "./steps";

/** PostgreSQL's default `scram_iterations`. */
const DEFAULT_ITERATIONS = 4096;
const SALT_BYTES = 16;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

export function factoryScramVerifier(password: string, options: { readonly salt?: Buffer; readonly iterations?: number } = {}): string {
  if (!PRINTABLE_ASCII.test(password)) throw new FactoryProvisioningError("database_password_invalid", "A role password must be printable ASCII.");
  const salt = options.salt ?? randomBytes(SALT_BYTES);
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const storedKey = createHash("sha256").update(createHmac("sha256", salted).update("Client Key").digest()).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}
