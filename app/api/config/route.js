import { NextResponse } from "next/server";
import { readConfig, writeConfig, persistenceMode } from "@/lib/store";
import { normalizeConfig, DEFAULT_CONFIG } from "@/lib/config";
import { listMetrics } from "@/lib/metrics";
import { getShopTimeZone } from "@/lib/shopify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const saved = await readConfig();
  const config = saved ? normalizeConfig(saved) : { ...DEFAULT_CONFIG };

  // Bucketing must follow the store's local calendar day, not UTC, or orders
  // placed in the evening (which cross into the next UTC day) get counted a day
  // late. "UTC" is only ever the app default — never a deliberate choice for
  // this store — so resolve it to the shop's timezone.
  if (!config.timeZone || config.timeZone === "UTC") {
    config.timeZone = await getShopTimeZone();
  }

  return NextResponse.json({
    config,
    isDefault: !saved,
    persistenceMode,
    metrics: listMetrics(),
  });
}

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const config = normalizeConfig(body);
  await writeConfig(config);
  return NextResponse.json({ config, persistenceMode });
}
