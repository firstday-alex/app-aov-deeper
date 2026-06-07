import { NextResponse } from "next/server";
import { fetchOrders } from "@/lib/shopify";
import { computeMetric } from "@/lib/metrics";
import { normalizeConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Order-heavy windows can take a while to paginate.
export const maxDuration = 60;

// Resolve the explicit [start, end] window. The client normally sends ISO
// dates; if absent we derive a trailing window from lookbackDays.
function resolveWindow(cfg, body) {
  let { start, end } = body || {};
  if (!end) end = new Date().toISOString();
  if (!start) {
    const startDate = new Date(end);
    startDate.setUTCDate(startDate.getUTCDate() - cfg.lookbackDays);
    start = startDate.toISOString();
  }
  return { start, end };
}

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const cfg = normalizeConfig(body.config || body);
  const { start, end } = resolveWindow(cfg, body);

  try {
    const { orders, pages, queryString, capped } = await fetchOrders({
      start,
      end,
      includeTestOrders: cfg.includeTestOrders,
    });

    const result = computeMetric(orders, cfg);

    return NextResponse.json({
      ...result,
      window: { start, end },
      config: cfg,
      fetch: { pages, queryString, ordersFetched: orders.length, capped },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err?.message || "Failed to compute metric" },
      { status: 502 }
    );
  }
}
