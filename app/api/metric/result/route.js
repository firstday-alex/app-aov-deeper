import { NextResponse } from "next/server";
import { pollBulk } from "@/lib/shopify";
import { aggregateBulkUrl } from "@/lib/bulkAggregate";
import { normalizeConfig } from "@/lib/config";
import { cacheSet } from "@/lib/store";
import { resolveWindow, bulkCacheKey, BULK_CACHE_TTL } from "@/lib/bulkHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Downloading + aggregating a large JSONL export can take a little while.
export const maxDuration = 300;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { opId } = body;
  if (!opId) return NextResponse.json({ error: "Missing opId" }, { status: 400 });

  const cfg = normalizeConfig(body.config || body);
  const window = body.window || resolveWindow(cfg, body);

  try {
    const op = await pollBulk(opId);
    if (op.status !== "COMPLETED") {
      return NextResponse.json(
        { error: `Export not complete (status: ${op.status})`, status: op.status },
        { status: 409 }
      );
    }
    if (!op.url) {
      // No rows matched the query — Shopify returns a completed op with no file.
      return NextResponse.json({
        metric: { id: cfg.metric },
        buckets: [],
        totals: {
          units: 0,
          transactions: 0,
          value: 0,
          sales: 0,
          newTransactions: 0,
          repeatTransactions: 0,
          unknownTransactions: 0,
        },
        discounts: { totalOrders: 0, ordersWithCode: 0, discountedOrders: 0, discountAmount: 0, codes: [] },
        onlineStoreOnly: cfg.onlineStoreOnly !== false,
        diagnostics: { ordersScanned: 0, ordersMatched: 0, excludedNonOnlineStore: 0 },
        window,
        config: cfg,
        fetch: { objectCount: Number(op.objectCount || 0), cached: false, empty: true },
      });
    }

    const result = await aggregateBulkUrl(op.url, cfg);

    // Remember this completed export so a re-run on the same window can reuse it.
    await cacheSet(bulkCacheKey(window, cfg), opId, BULK_CACHE_TTL);

    return NextResponse.json({
      ...result,
      window,
      config: cfg,
      fetch: { objectCount: Number(op.objectCount || 0) },
    });
  } catch (err) {
    return NextResponse.json({ error: err?.message || "Failed to aggregate result" }, { status: 502 });
  }
}
