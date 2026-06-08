// Default parameters + normalization. These defaults are what the UI loads on
// first run; the user can edit them and "Save as defaults" to persist to KV.

export const DEFAULT_CONFIG = {
  metric: "upt", // see lib/metrics.js registry
  // Sales basis for money metrics (AOV, net sales per item). Computed per line
  // item so item exclusions apply. Does not subtract returns/refunds.
  //   "net"        = originalTotal - all discount allocations (excl tax/shipping)
  //   "gross"      = originalTotal (before discounts)
  //   "netWithTax" = net + per-line tax (still excludes shipping)
  salesBasis: "net",
  // Time window. If start/end omitted, the API derives a trailing window from
  // `lookbackDays`. The UI sends explicit ISO dates.
  lookbackDays: 30,
  granularity: "day", // "day" | "week" | "month"
  timeZone: "UTC", // IANA tz used for bucketing order createdAt
  // Line items whose name/title/product title contains ANY of these substrings
  // (case-insensitive) are excluded from the units count.
  excludeNames: ["rapid hydration"],
  // Upsell detection via line-item properties (Admin API `customAttributes`).
  // A line item counts as an upsell when it carries the property `upsellPropertyKey`
  // whose value is one of `upsellPropertyValues`. An empty values list matches on
  // the presence of the key alone. Matching is case-insensitive. Feeds the
  // "Upsell Units per Order" and "Upsell Order Penetration" metrics.
  upsellPropertyKey: "",
  upsellPropertyValues: [],
  // Optional landing-page path filter (e.g. "/pages/offer-a"). Empty = no filter.
  landingPagePath: "",
  landingPageMatch: "startsWith", // "exact" | "startsWith" | "contains"
  // Count orders that had zero included units as transactions?
  countEmptyOrders: false,
  // Exclude Shopify test orders from the fetch.
  includeTestOrders: false,
};

const GRANULARITIES = new Set(["day", "week", "month"]);
const MATCHERS = new Set(["exact", "startsWith", "contains"]);
const SALES_BASES = new Set(["net", "gross", "netWithTax"]);

// Merge an arbitrary (possibly partial / user-supplied) object onto the defaults
// and coerce types so the rest of the app can trust the shape.
export function normalizeConfig(input = {}) {
  const c = { ...DEFAULT_CONFIG, ...input };
  return {
    metric: String(c.metric || DEFAULT_CONFIG.metric),
    salesBasis: SALES_BASES.has(c.salesBasis) ? c.salesBasis : DEFAULT_CONFIG.salesBasis,
    lookbackDays: clampInt(c.lookbackDays, 1, 730, DEFAULT_CONFIG.lookbackDays),
    granularity: GRANULARITIES.has(c.granularity) ? c.granularity : DEFAULT_CONFIG.granularity,
    timeZone: String(c.timeZone || DEFAULT_CONFIG.timeZone),
    excludeNames: toStringArray(c.excludeNames),
    upsellPropertyKey: String(c.upsellPropertyKey || "").trim(),
    upsellPropertyValues: toStringArray(c.upsellPropertyValues),
    landingPagePath: String(c.landingPagePath || "").trim(),
    landingPageMatch: MATCHERS.has(c.landingPageMatch) ? c.landingPageMatch : DEFAULT_CONFIG.landingPageMatch,
    countEmptyOrders: Boolean(c.countEmptyOrders),
    includeTestOrders: Boolean(c.includeTestOrders),
  };
}

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function toStringArray(v) {
  if (Array.isArray(v)) {
    return v.map((s) => String(s).trim()).filter(Boolean);
  }
  if (typeof v === "string") {
    // allow comma- or newline-separated input from a textarea
    return v
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}
