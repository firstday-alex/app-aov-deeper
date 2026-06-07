// Extensible metric engine.
//
// Adding a new metric (e.g. AOV) is a two-step change:
//   1. accumulate whatever raw values it needs in `aggregateOrders` (e.g. revenue),
//      adding the corresponding field to the GraphQL query in lib/shopify.js.
//   2. register it in METRICS with a `value(agg)` function and display metadata.
//
// Every metric is computed over the same per-bucket aggregate, so they all share
// the filtering pipeline (exclude-names, landing-page path, test orders, etc.).

export const METRICS = {
  upt: {
    id: "upt",
    label: "Units per Transaction",
    description: "Total included units / number of transactions",
    unit: "units/txn",
    decimals: 2,
    value: (agg) => (agg.transactions > 0 ? agg.units / agg.transactions : 0),
  },
  // Example of how the next metric would slot in (kept commented until revenue
  // is added to the order query):
  // aov: {
  //   id: "aov",
  //   label: "Average Order Value",
  //   unit: "$/txn",
  //   decimals: 2,
  //   value: (agg) => (agg.transactions > 0 ? agg.revenue / agg.transactions : 0),
  // },
};

export function listMetrics() {
  return Object.values(METRICS).map(({ id, label, description, unit }) => ({
    id,
    label,
    description,
    unit,
  }));
}

// ---- filtering helpers ----

function lineItemExcluded(li, excludeNamesLower) {
  if (excludeNamesLower.length === 0) return false;
  const haystack = [li.name, li.title, li.product?.title]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return excludeNamesLower.some((needle) => haystack.includes(needle));
}

function pathFromUrl(maybeUrl) {
  if (!maybeUrl) return null;
  try {
    // landingPage may be a full URL or already a path
    if (maybeUrl.startsWith("/")) return maybeUrl.split("?")[0];
    return new URL(maybeUrl).pathname;
  } catch {
    return null;
  }
}

function pathMatches(path, target, mode) {
  if (!path) return false;
  const a = path.replace(/\/+$/, "") || "/";
  const b = target.replace(/\/+$/, "") || "/";
  if (mode === "exact") return a === b;
  if (mode === "contains") return a.includes(b);
  return a.startsWith(b); // startsWith (default)
}

// Returns { units, included } for an order under the given config, or null if
// the order is filtered out entirely.
function processOrder(order, cfg, excludeNamesLower) {
  if (cfg.landingPagePath) {
    const lp =
      order.customerJourneySummary?.lastVisit?.landingPage ||
      order.customerJourneySummary?.firstVisit?.landingPage;
    const path = pathFromUrl(lp);
    if (!pathMatches(path, cfg.landingPagePath, cfg.landingPageMatch)) {
      return null; // no attribution or path mismatch -> excluded
    }
  }

  let units = 0;
  for (const li of order.lineItems?.nodes || []) {
    if (lineItemExcluded(li, excludeNamesLower)) continue;
    units += li.quantity || 0;
  }

  if (units === 0 && !cfg.countEmptyOrders) return null;
  return { units };
}

// ---- bucketing ----

// Returns { key, label } for an ISO timestamp under a granularity + timezone.
function bucketFor(iso, granularity, timeZone) {
  const d = new Date(iso);
  // Extract Y/M/D in the configured timezone.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(d).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const y = Number(parts.year);
  const m = Number(parts.month);
  const day = Number(parts.day);

  if (granularity === "month") {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    return { key, label: key };
  }

  if (granularity === "week") {
    // ISO week: Monday-based. Work in UTC on the tz-local calendar date.
    const utc = new Date(Date.UTC(y, m - 1, day));
    const dow = (utc.getUTCDay() + 6) % 7; // 0 = Monday
    utc.setUTCDate(utc.getUTCDate() - dow);
    const key = `${utc.getUTCFullYear()}-${String(utc.getUTCMonth() + 1).padStart(2, "0")}-${String(
      utc.getUTCDate()
    ).padStart(2, "0")}`;
    return { key, label: `Week of ${key}` };
  }

  // day
  const key = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { key, label: key };
}

// ---- main entry ----

// orders: array of order nodes from lib/shopify.js
// cfg: normalized config (see lib/config.js)
export function computeMetric(orders, cfg) {
  const metricDef = METRICS[cfg.metric] || METRICS.upt;
  const excludeNamesLower = cfg.excludeNames.map((s) => s.toLowerCase());

  const bucketMap = new Map(); // key -> { key, label, units, transactions }
  const totals = { units: 0, transactions: 0 };
  let ordersScanned = orders.length;
  let ordersMatched = 0;

  for (const order of orders) {
    const res = processOrder(order, cfg, excludeNamesLower);
    if (!res) continue;
    ordersMatched += 1;

    const { key, label } = bucketFor(order.createdAt, cfg.granularity, cfg.timeZone);
    let b = bucketMap.get(key);
    if (!b) {
      b = { key, label, units: 0, transactions: 0 };
      bucketMap.set(key, b);
    }
    b.units += res.units;
    b.transactions += 1;
    totals.units += res.units;
    totals.transactions += 1;
  }

  const buckets = [...bucketMap.values()]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((b) => ({ ...b, value: round(metricDef.value(b), metricDef.decimals) }));

  return {
    metric: { id: metricDef.id, label: metricDef.label, unit: metricDef.unit },
    buckets,
    totals: {
      ...totals,
      value: round(metricDef.value(totals), metricDef.decimals),
    },
    diagnostics: { ordersScanned, ordersMatched },
  };
}

function round(n, decimals = 2) {
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * f) / f;
}
