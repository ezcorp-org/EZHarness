/**
 * A sender process the crash test kills between the send and the settlement
 * (C11 N7). Everything it needs arrives in its environment, never in argv.
 * It runs one pass and writes "settled" only if it reached the settlement,
 * which the crash test asserts it never does.
 */
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "../../../src/db/schema";
import { FactoryNotificationSender } from "../../../src/factory/notification-sender";

const input = JSON.parse(process.env.FACTORY_NOTIFY_CHILD ?? "{}") as { databaseUrl: string; tenantId: string; leaseMs: number; destination: { name: string; url: string; ca: string; secret: string } };
const client = new SQL(input.databaseUrl, { max: 2 });
const sender = new FactoryNotificationSender({
  database: drizzle(client, { schema }) as never,
  tenantId: input.tenantId,
  leaseMs: input.leaseMs,
  destinations: [{ name: input.destination.name, url: input.destination.url, ca: input.destination.ca, secret: Buffer.from(input.destination.secret, "base64") }],
  // No renewals: the lease must lapse once this process is gone.
  heartbeat: () => () => undefined,
});
await sender.step(new AbortController().signal);
process.stdout.write("settled\n");
await client.close();
