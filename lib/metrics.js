// Extensible metric engine.
//
// Adding a new metric (e.g. AOV) is a two-step change:
//   1. accumulate whatever raw values it needs (e.g. revenue), adding the
//      corresponding field to the bulk query in lib/shopify.js.
//   2. register it in METRICS with a `value(agg)` function and display metadata.
//
// The engine is fed via an accumulator so it can aggregate a streamed JSONL
// bulk export line-by-line without holding every order in memory.

export const METRICS = {
  upt: {
    id: "upt",
    label: "Units per Transaction",
    description: "Total included units / number of transactions",
    unit: "units/txn",
    decimals: 2,
    value: (agg) => (agg.transactions > 0 ? agg.units / agg.transactions : 0),
  },
  // aov: {
  //   id: "aov", label: "Average Order Value", unit: "$/txn", decimals: 2,
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
  return a.startsWith(b);
}

export function landingPageOf(order) {
  return (
    order?.customerJourneySummary?.lastVisit?.landingPage ||
    order?.customerJourneySummary?.firstVisit?.landingPage ||
    null
  );
}

// ---- bucketing ----

function bucketFor(iso, granularity, timeZone) {
  const d = new Date(iso);
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
    const utc = new Date(Date.UTC(y, m - 1, day));
    const dow = (utc.getUTCDay() + 6) % 7; // 0 = Monday
    utc.setUTCDate(utc.getUTCDate() - dow);
    const key = `${utc.getUTCFullYear()}-${String(utc.getUTCMonth() + 1).padStart(2, "0")}-${String(
      utc.getUTCDate()
    ).padStart(2, "0")}`;
    return { key, label: `Week of ${key}` };
  }
  const key = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { key, label: key };
}

function round(n, decimals = 2) {
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * f) / f;
}

// ---- accumulator (streaming-friendly) ----
//
// Feed orders and their line items in any order (line items may arrive before or
// after their parent order, as in bulk JSONL). Call finalize() once to compute.
export function createAccumulator(cfg) {
  const excludeNamesLower = cfg.excludeNames.map((s) => s.toLowerCase());
  const orders = new Map(); // orderId -> { createdAt, landingPage, units }

  function ensure(id) {
    let o = orders.get(id);
    if (!o) {
      o = { createdAt: null, landingPage: null, units: 0 };
      orders.set(id, o);
    }
    return o;
  }

  return {
    ordersSeen: () => orders.size,

    addOrder(id, createdAt, landingPage) {
      const o = ensure(id);
      o.createdAt = createdAt;
      o.landingPage = landingPage;
    },

    addLineItem(parentId, li) {
      if (lineItemExcluded(li, excludeNamesLower)) return;
      const o = ensure(parentId);
      o.units += li.quantity || 0;
    },

    finalize() {
      const metricDef = METRICS[cfg.metric] || METRICS.upt;
      const bucketMap = new Map();
      const totals = { units: 0, transactions: 0 };
      let ordersMatched = 0;

      for (const o of orders.values()) {
        if (!o.createdAt) continue; // a stray child with no parent order line

        if (cfg.landingPagePath) {
          const path = pathFromUrl(o.landingPage);
          if (!pathMatches(path, cfg.landingPagePath, cfg.landingPageMatch)) continue;
        }
        if (o.units === 0 && !cfg.countEmptyOrders) continue;

        ordersMatched += 1;
        const { key, label } = bucketFor(o.createdAt, cfg.granularity, cfg.timeZone);
        let b = bucketMap.get(key);
        if (!b) {
          b = { key, label, units: 0, transactions: 0 };
          bucketMap.set(key, b);
        }
        b.units += o.units;
        b.transactions += 1;
        totals.units += o.units;
        totals.transactions += 1;
      }

      const buckets = [...bucketMap.values()]
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((b) => ({ ...b, value: round(metricDef.value(b), metricDef.decimals) }));

      return {
        metric: { id: metricDef.id, label: metricDef.label, unit: metricDef.unit },
        buckets,
        totals: { ...totals, value: round(metricDef.value(totals), metricDef.decimals) },
        diagnostics: { ordersScanned: orders.size, ordersMatched },
      };
    },
  };
}

// Array-of-orders convenience (used by tests and any non-bulk path).
export function computeMetric(orders, cfg) {
  const acc = createAccumulator(cfg);
  for (const order of orders) {
    acc.addOrder(order.id, order.createdAt, landingPageOf(order));
    for (const li of order.lineItems?.nodes || []) {
      acc.addLineItem(order.id, li);
    }
  }
  return acc.finalize();
}
