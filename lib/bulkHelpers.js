// Shared helpers for the bulk metric endpoints.

// Resolve the explicit [start, end] window. The client normally sends ISO dates;
// if absent we derive a trailing window from lookbackDays.
export function resolveWindow(cfg, body) {
  let start = body?.start;
  let end = body?.end;
  if (!end) end = new Date().toISOString();
  if (!start) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - cfg.lookbackDays);
    start = d.toISOString();
  }
  return { start, end };
}

// customerJourneySummary is now always part of the export — it carries
// customerOrderIndex (new vs repeat) as well as landing pages — so every export
// has the same shape regardless of the landing-page options.
export function needsJourney() {
  return true;
}

// Cache key for a completed bulk export. Only fetch-affecting inputs are
// included; exclude-names / landing-path matching happen at aggregation time.
export function bulkCacheKey(window, cfg) {
  const test = cfg.includeTestOrders ? 1 : 0;
  // v3: export now always includes customerJourneySummary.customerOrderIndex,
  // sourceName, discountCodes and totalDiscountsSet (new/repeat + discount mix).
  // Bumped from v2 so we don't reuse older, narrower exports.
  return `aov-deeper:bulk:v3:${window.start}:${window.end}:t${test}`;
}

export const BULK_CACHE_TTL = 6 * 24 * 60 * 60; // 6 days (export URLs expire at 7)
