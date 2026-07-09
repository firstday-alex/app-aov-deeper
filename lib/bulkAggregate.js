// Streams a Shopify bulk JSONL export and aggregates it into a metric result.
//
// In an ungrouped bulk export, every object is one JSONL line. Root objects
// (orders) have no __parentId; nested connection nodes (line items) carry a
// __parentId pointing at their order's gid. Non-connection nested objects
// (e.g. product, customerJourneySummary) are inlined on their parent's line.
import { createAccumulator, orderMetaOf } from "@/lib/metrics";

const ORDER_GID = "gid://shopify/Order/";

function dispatch(obj, acc) {
  if (obj.__parentId) {
    // A line item belonging to an order.
    if (obj.__parentId.startsWith(ORDER_GID)) {
      acc.addLineItem(obj.__parentId, obj);
    }
    return;
  }
  // A root order object.
  if (typeof obj.id === "string" && obj.id.startsWith(ORDER_GID)) {
    acc.addOrder(obj.id, obj.createdAt, orderMetaOf(obj));
  }
}

export async function aggregateBulkUrl(url, cfg) {
  const acc = createAccumulator(cfg);

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to download bulk result: HTTP ${res.status}`);
  if (!res.body) {
    // Fallback: no stream available, parse whole text.
    const text = await res.text();
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (t) dispatch(JSON.parse(t), acc);
    }
    return acc.finalize();
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lines = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        dispatch(JSON.parse(line), acc);
        lines += 1;
      }
    }
  }
  const tail = buffer.trim();
  if (tail) {
    dispatch(JSON.parse(tail), acc);
    lines += 1;
  }

  const result = acc.finalize();
  result.diagnostics.jsonlLines = lines;
  return result;
}
