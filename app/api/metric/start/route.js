import { NextResponse } from "next/server";
import { startOrdersBulk, pollBulk } from "@/lib/shopify";
import { normalizeConfig } from "@/lib/config";
import { cacheGet } from "@/lib/store";
import { resolveWindow, needsJourney, bulkCacheKey } from "@/lib/bulkHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const cfg = normalizeConfig(body.config || body);
  const window = resolveWindow(cfg, body);

  try {
    // Reuse a still-valid completed export for the same fetch window.
    const cachedId = await cacheGet(bulkCacheKey(window, cfg));
    if (cachedId) {
      const op = await pollBulk(cachedId);
      if (op.status === "COMPLETED" && op.url) {
        return NextResponse.json({ opId: cachedId, status: "COMPLETED", cached: true, window });
      }
    }

    const op = await startOrdersBulk({
      start: window.start,
      end: window.end,
      includeTestOrders: cfg.includeTestOrders,
      needsJourney: needsJourney(cfg),
    });
    return NextResponse.json({ opId: op.id, status: op.status, reused: op.reused || false, window });
  } catch (err) {
    return NextResponse.json({ error: err?.message || "Failed to start export" }, { status: 502 });
  }
}
