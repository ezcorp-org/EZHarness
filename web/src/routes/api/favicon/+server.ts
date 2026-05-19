import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, locals }) => {
  requireAuth(locals);
  const rawUrl = url.searchParams.get("url");
  if (!rawUrl) return errorJson(400, "url parameter required");
  try {
    const domain = new URL(
      rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`,
    ).hostname;
    const faviconRes = await fetch(
      `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
    );
    if (!faviconRes.ok)
      return errorJson(502, "Failed to fetch favicon");
    const buf = await faviconRes.arrayBuffer();
    const base64 = Buffer.from(buf).toString("base64");
    return json({ icon: `data:image/png;base64,${base64}` });
  } catch {
    return errorJson(400, "Invalid URL");
  }
};
