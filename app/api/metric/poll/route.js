import { NextResponse } from "next/server";
import { pollBulk } from "@/lib/shopify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    const op = await pollBulk(id);
    return NextResponse.json({
      status: op.status, // CREATED | RUNNING | COMPLETED | FAILED | CANCELED ...
      objectCount: Number(op.objectCount || 0),
      errorCode: op.errorCode || null,
      ready: op.status === "COMPLETED" && Boolean(op.url),
    });
  } catch (err) {
    return NextResponse.json({ error: err?.message || "Poll failed" }, { status: 502 });
  }
}
