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

// A landing-page filter requires the (expensive) customerJourneySummary fields,
// which changes the shape of the export — so it's part of the cache identity.
export function needsJourney(cfg) {
  return Boolean(cfg.landingPagePath);
}

// Cache key for a completed bulk export. Only fetch-affecting inputs are
// included; exclude-names / landing-path matching happen at aggregation time.
export function bulkCacheKey(window, cfg) {
  const test = cfg.includeTestOrders ? 1 : 0;
  const journey = needsJourney(cfg) ? 1 : 0;
  // v2: export now includes lineItems.customAttributes (line-item properties).
  return `aov-deeper:bulk:v2:${window.start}:${window.end}:t${test}:j${journey}`;
}

export const BULK_CACHE_TTL = 6 * 24 * 60 * 60; // 6 days (export URLs expire at 7)
