import { request as playwrightRequest, type APIRequestContext } from "@playwright/test";
import { expect } from "./hydration.js";

export async function acceptMemberInvitation(administrator: APIRequestContext, member: APIRequestContext, name: string): Promise<void> {
  const email = `member-${crypto.randomUUID()}@example.test`;
  const invitation = await administrator.post("/api/auth/invite", { data: { email, role: "member" } });
  expect(invitation.status(), await invitation.text()).toBe(201);
  const { invite } = await invitation.json();
  const accepted = await member.post(`/api/auth/invite/${invite.token}`, { data: { name, email, password: "Member-Session-E2e-9x!" } });
  expect(accepted.status(), await accepted.text()).toBe(201);
  const profile = await member.get("/api/auth/me");
  expect(profile.status(), await profile.text()).toBe(200);
  expect((await profile.json()).user.role).toBe("member");
}

export async function createMemberSession(administrator: APIRequestContext, baseURL: string, name: string): Promise<APIRequestContext> {
  const member = await playwrightRequest.newContext({ baseURL });
  try {
    await acceptMemberInvitation(administrator, member, name);
    return member;
  } catch (error) {
    await member.dispose();
    throw error;
  }
}
