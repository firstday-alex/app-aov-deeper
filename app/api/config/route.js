import { NextResponse } from "next/server";
import { readConfig, writeConfig, persistenceMode } from "@/lib/store";
import { normalizeConfig, DEFAULT_CONFIG } from "@/lib/config";
import { listMetrics } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const saved = await readConfig();
  const config = saved ? normalizeConfig(saved) : DEFAULT_CONFIG;
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
