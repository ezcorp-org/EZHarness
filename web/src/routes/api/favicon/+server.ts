import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, locals }) => {
  requireAuth(locals);
  const rawUrl = url.searchParams.get("url");
  if (!rawUrl) return json({ error: "url parameter required" }, { status: 400 });
  try {
    const domain = new URL(
      rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`,
    ).hostname;
    const faviconRes = await fetch(
      `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
    );
    if (!faviconRes.ok)
      return json({ error: "Failed to fetch favicon" }, { status: 502 });
    const buf = await faviconRes.arrayBuffer();
    const base64 = Buffer.from(buf).toString("base64");
    return json({ icon: `data:image/png;base64,${base64}` });
  } catch {
    return json({ error: "Invalid URL" }, { status: 400 });
  }
};
