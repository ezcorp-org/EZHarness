import { eq, and } from "drizzle-orm";
import { getDb } from "../connection";
import { userCommands, type UserCommand, type NewUserCommand } from "../schema";

/**
 * Thin CRUD wrapper over the `user_commands` table. This is the
 * DB-backed source of slash commands; the registry (see
 * `src/runtime/commands/registry.ts`) pairs these rows with the
 * filesystem-discovered commands when building a popover result set.
 */

export async function listUserCommands(userId: string): Promise<UserCommand[]> {
  return getDb()
    .select()
    .from(userCommands)
    .where(eq(userCommands.userId, userId));
}

export async function getUserCommand(
  userId: string,
  name: string,
): Promise<UserCommand | undefined> {
  const rows = await getDb()
    .select()
    .from(userCommands)
    .where(and(eq(userCommands.userId, userId), eq(userCommands.name, name)));
  return rows[0];
}

export interface CreateUserCommandInput {
  userId: string;
  name: string;
  description?: string;
  body: string;
  frontmatter?: Record<string, string>;
}

export async function createUserCommand(
  input: CreateUserCommandInput,
): Promise<UserCommand> {
  const now = new Date();
  const row: NewUserCommand = {
    id: crypto.randomUUID(),
    userId: input.userId,
    name: input.name,
    description: input.description ?? "",
    body: input.body,
    frontmatter: input.frontmatter ?? {},
    createdAt: now,
    updatedAt: now,
  };
  await getDb().insert(userCommands).values(row);
  return row as UserCommand;
}

export interface UpdateUserCommandInput {
  description?: string;
  body?: string;
  frontmatter?: Record<string, string>;
}

export async function updateUserCommand(
  userId: string,
  name: string,
  patch: UpdateUserCommandInput,
): Promise<UserCommand | undefined> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.description !== undefined) updates.description = patch.description;
  if (patch.body !== undefined) updates.body = patch.body;
  if (patch.frontmatter !== undefined) updates.frontmatter = patch.frontmatter;

  await getDb()
    .update(userCommands)
    .set(updates)
    .where(and(eq(userCommands.userId, userId), eq(userCommands.name, name)));
  return getUserCommand(userId, name);
}

export async function deleteUserCommand(
  userId: string,
  name: string,
): Promise<boolean> {
  const existing = await getUserCommand(userId, name);
  if (!existing) return false;
  await getDb()
    .delete(userCommands)
    .where(and(eq(userCommands.userId, userId), eq(userCommands.name, name)));
  return true;
}
