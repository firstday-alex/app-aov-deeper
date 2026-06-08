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
    description: "Included units / transactions",
    unit: "units/txn",
    money: false,
    decimals: 2,
    value: (agg) => (agg.transactions > 0 ? agg.units / agg.transactions : 0),
  },
  aov: {
    id: "aov",
    label: "Average Order Value",
    description: "Net sales / transactions",
    unit: "/txn",
    money: true,
    decimals: 2,
    value: (agg) => (agg.transactions > 0 ? agg.sales / agg.transactions : 0),
  },
  nspi: {
    id: "nspi",
    label: "Net Sales per Item Sold",
    description: "Net sales / included units",
    unit: "/item",
    money: true,
    decimals: 2,
    value: (agg) => (agg.units > 0 ? agg.sales / agg.units : 0),
  },
  upsellPerOrder: {
    id: "upsellPerOrder",
    label: "Upsell Units per Order",
    description: "Upsell units / transactions",
    unit: "units/order",
    money: false,
    decimals: 3,
    value: (agg) => (agg.transactions > 0 ? agg.upsellUnits / agg.transactions : 0),
  },
  upsellPenetration: {
    id: "upsellPenetration",
    label: "Upsell Order Penetration",
    description: "Orders with an upsell / transactions",
    unit: "% of orders",
    money: false,
    decimals: 1,
    value: (agg) =>
      agg.transactions > 0 ? (agg.upsellOrders / agg.transactions) * 100 : 0,
  },
};

export function listMetrics() {
  return Object.values(METRICS).map(({ id, label, description, unit, money }) => ({
    id,
    label,
    description,
    unit,
    money: Boolean(money),
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

// True when a line item carries the configured upsell property. Matching is
// case-insensitive on both key and value; an empty values list matches on the
// presence of the key alone. `customAttributes` is the Admin-API representation
// of storefront line-item properties (including `_`-prefixed hidden ones).
function lineItemIsUpsell(li, keyLower, valuesLower) {
  if (!keyLower) return false;
  for (const a of li.customAttributes || []) {
    if ((a.key || "").toLowerCase() !== keyLower) continue;
    if (valuesLower.length === 0) return true;
    if (valuesLower.includes((a.value || "").toLowerCase())) return true;
  }
  return false;
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

function num(s) {
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

// Net/gross/net+tax sales for a single line item, per the configured basis.
// All amounts use shopMoney (the store's own currency). Shipping is never
// included (it isn't a line item). Returns/refunds are not subtracted.
function lineSales(li, basis) {
  const original = num(li.originalTotalSet?.shopMoney?.amount);
  if (basis === "gross") return original;

  let discounts = 0;
  for (const a of li.discountAllocations || []) {
    discounts += num(a.allocatedAmountSet?.shopMoney?.amount);
  }
  const net = original - discounts;
  if (basis === "netWithTax") {
    let tax = 0;
    for (const t of li.taxLines || []) tax += num(t.priceSet?.shopMoney?.amount);
    return net + tax;
  }
  return net; // "net"
}

function currencyOf(li) {
  return li.originalTotalSet?.shopMoney?.currencyCode || null;
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
  const upsellKeyLower = (cfg.upsellPropertyKey || "").toLowerCase();
  const upsellValuesLower = (cfg.upsellPropertyValues || []).map((s) => s.toLowerCase());
  const basis = cfg.salesBasis || "net";
  const orders = new Map(); // orderId -> { createdAt, landingPage, units, sales, upsellUnits, hasUpsell }
  let currency = null;

  function ensure(id) {
    let o = orders.get(id);
    if (!o) {
      o = { createdAt: null, landingPage: null, units: 0, sales: 0, upsellUnits: 0, hasUpsell: false };
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
      o.sales += lineSales(li, basis);
      if (lineItemIsUpsell(li, upsellKeyLower, upsellValuesLower)) {
        o.upsellUnits += li.quantity || 0;
        o.hasUpsell = true;
      }
      if (!currency) currency = currencyOf(li);
    },

    finalize() {
      const metricDef = METRICS[cfg.metric] || METRICS.upt;
      const bucketMap = new Map();
      const totals = { units: 0, transactions: 0, sales: 0, upsellUnits: 0, upsellOrders: 0 };
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
          b = { key, label, units: 0, transactions: 0, sales: 0, upsellUnits: 0, upsellOrders: 0 };
          bucketMap.set(key, b);
        }
        b.units += o.units;
        b.transactions += 1;
        b.sales += o.sales;
        b.upsellUnits += o.upsellUnits;
        b.upsellOrders += o.hasUpsell ? 1 : 0;
        totals.units += o.units;
        totals.transactions += 1;
        totals.sales += o.sales;
        totals.upsellUnits += o.upsellUnits;
        totals.upsellOrders += o.hasUpsell ? 1 : 0;
      }

      const buckets = [...bucketMap.values()]
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((b) => ({
          ...b,
          sales: round(b.sales, 2),
          value: round(metricDef.value(b), metricDef.decimals),
        }));

      return {
        metric: {
          id: metricDef.id,
          label: metricDef.label,
          unit: metricDef.unit,
          money: Boolean(metricDef.money),
        },
        currency,
        salesBasis: basis,
        buckets,
        totals: {
          ...totals,
          sales: round(totals.sales, 2),
          value: round(metricDef.value(totals), metricDef.decimals),
        },
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
