import { NextResponse } from "next/server";
import { shopifyqlQuery } from "@/lib/shopify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Top landing pages by sessions over a window, via ShopifyQL (read-only).
// Body: { start, end, limit? }. start/end are ISO; ShopifyQL takes YYYY-MM-DD.
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const start = String(body.start || "").slice(0, 10);
  const end = String(body.end || "").slice(0, 10);
  const limit = Math.min(Math.max(parseInt(body.limit, 10) || 10, 1), 50);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return NextResponse.json({ error: "start and end must be YYYY-MM-DD dates" }, { status: 400 });
  }

  // SINCE/UNTIL take bare dates; landing_page_path is a path like "/pages/sale".
  const q = `FROM sessions SHOW sessions GROUP BY landing_page_path SINCE ${start} UNTIL ${end} ORDER BY sessions DESC LIMIT ${limit}`;

  try {
    const { rows } = await shopifyqlQuery(q);
    const landingPages = rows
      .map((r) => ({
        path: normalizePath(r.landing_page_path),
        sessions: Number(r.sessions) || 0,
      }))
      .filter((r) => r.path);
    return NextResponse.json({ landingPages, window: { start, end } });
  } catch (err) {
    return NextResponse.json({ error: err?.message || "ShopifyQL query failed" }, { status: 502 });
  }
}

// Keep in lockstep with normalizePath in lib/metrics.js so session paths join
// cleanly with order landing-page paths.
function normalizePath(path) {
  if (!path) return null;
  const s = String(path).replace(/[?#].*$/, "").replace(/\/+$/, "");
  return s === "" ? "/" : s;
}
