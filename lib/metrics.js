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

// Canonical landing-page path for grouping/joining: drop the query/hash (already
// done by pathFromUrl), strip a trailing slash. Matches the path format Shopify's
// `sessions` dataset returns (e.g. "/pages/sale"), so the two join cleanly.
function normalizePath(path) {
  if (!path) return null;
  const s = path.replace(/[?#].*$/, "").replace(/\/+$/, "");
  return s === "" ? "/" : s;
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

// The Online Store sales channel writes sourceName === "web". Everything else
// (POS, draft orders, other channels/apps) is treated as non-online-store.
export const ONLINE_STORE_SOURCE = "web";

// Discount codes matching a group prefix are rolled up under a single label in
// the code-mix analysis (e.g. every REW-* loyalty code counts as one bucket).
// Matching is case-insensitive on the code prefix.
export const DISCOUNT_CODE_GROUPS = [
  { prefix: "REW-", label: "REW-LOYALTY-CODES" },
];

export function groupDiscountCode(code) {
  const up = String(code || "").toUpperCase();
  for (const g of DISCOUNT_CODE_GROUPS) {
    if (up.startsWith(g.prefix)) return g.label;
  }
  return code;
}

// Extracts the order-level fields the accumulator needs beyond line items:
//   - landingPage        : for the landing-page breakdown
//   - sourceName         : for the Online Store scope
//   - customerOrderIndex : 1 => new customer order, >1 => repeat (null unknown)
//   - discountCodes      : discount codes applied (drives the code-mix analysis)
//   - totalDiscounts     : order-level discount amount (captures automatic
//                          discounts that carry no code)
export function orderMetaOf(order) {
  const codes = Array.isArray(order?.discountCodes)
    ? order.discountCodes.filter(Boolean)
    : [];
  return {
    landingPage: landingPageOf(order),
    sourceName: order?.sourceName ?? null,
    customerOrderIndex:
      order?.customerJourneySummary?.customerOrderIndex ?? null,
    discountCodes: codes,
    totalDiscounts: num(order?.totalDiscountsSet?.shopMoney?.amount),
  };
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

// A bucket/totals record carries the base rollup plus a new/repeat breakdown so
// the metric (e.g. UPT) and the new-vs-repeat split share one pass.
function emptySegmentedTotals() {
  return {
    units: 0,
    transactions: 0,
    sales: 0,
    upsellUnits: 0,
    upsellOrders: 0,
    newTransactions: 0,
    repeatTransactions: 0,
    unknownTransactions: 0,
    newUnits: 0,
    repeatUnits: 0,
    unknownUnits: 0,
    newSales: 0,
    repeatSales: 0,
    unknownSales: 0,
    codeOrders: 0,        // orders that used >= 1 discount code
    discountedOrders: 0,  // orders discounted at all (code or automatic)
    discountAmount: 0,    // total discount amount on discounted orders
  };
}

// Folds one order into a segmented record. `seg` is "new" | "repeat" | "unknown".
function addSegmented(target, o, seg) {
  target.units += o.units;
  target.transactions += 1;
  target.sales += o.sales;
  target.upsellUnits += o.upsellUnits;
  target.upsellOrders += o.hasUpsell ? 1 : 0;
  target[`${seg}Transactions`] += 1;
  target[`${seg}Units`] += o.units;
  target[`${seg}Sales`] += o.sales;
}

// Rounds the money fields of a segmented record for output.
function roundSegmentedSales(rec) {
  return {
    ...rec,
    sales: round(rec.sales, 2),
    newSales: round(rec.newSales, 2),
    repeatSales: round(rec.repeatSales, 2),
    unknownSales: round(rec.unknownSales, 2),
    discountAmount: round(rec.discountAmount, 2),
  };
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
  const onlineStoreOnly = cfg.onlineStoreOnly !== false;
  const orders = new Map(); // orderId -> per-order accumulator (see ensure)
  let currency = null;

  function ensure(id) {
    let o = orders.get(id);
    if (!o) {
      o = {
        createdAt: null,
        landingPage: null,
        sourceName: null,
        customerOrderIndex: null,
        discountCodes: [],
        totalDiscounts: 0,
        units: 0,
        sales: 0,
        upsellUnits: 0,
        hasUpsell: false,
      };
      orders.set(id, o);
    }
    return o;
  }

  return {
    ordersSeen: () => orders.size,

    addOrder(id, createdAt, meta) {
      const o = ensure(id);
      o.createdAt = createdAt;
      const m = meta || {};
      o.landingPage = m.landingPage ?? null;
      o.sourceName = m.sourceName ?? null;
      o.customerOrderIndex = m.customerOrderIndex ?? null;
      o.discountCodes = Array.isArray(m.discountCodes) ? m.discountCodes : [];
      o.totalDiscounts = Number(m.totalDiscounts) || 0;
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
      const totals = emptySegmentedTotals();
      let ordersMatched = 0;
      let excludedNonOnlineStore = 0;

      // Optional per-landing-page breakdown (UPT Diagnosis "by landing page").
      const landingMap = cfg.landingBreakdown ? new Map() : null;
      let landingWithPath = 0;

      // Per-code discount mix (window-level). Per-period code/discount counts
      // live on each bucket (codeOrders / discountedOrders / discountAmount) so
      // penetration can be charted period over period.
      const codeMap = new Map(); // code -> { code, orders, sales, discountAmount }

      for (const o of orders.values()) {
        if (!o.createdAt) continue; // a stray child with no parent order line

        // Scope to Online Store orders (sourceName === "web") when enabled.
        if (onlineStoreOnly && o.sourceName !== ONLINE_STORE_SOURCE) {
          excludedNonOnlineStore += 1;
          continue;
        }

        if (cfg.landingPagePath) {
          const path = pathFromUrl(o.landingPage);
          if (!pathMatches(path, cfg.landingPagePath, cfg.landingPageMatch)) continue;
        }
        if (o.units === 0 && !cfg.countEmptyOrders) continue;

        ordersMatched += 1;

        // New vs repeat: customerOrderIndex is the order's position in the
        // customer's history (1 = first/new, >1 = repeat). Null when Shopify
        // hasn't attributed the order (e.g. no online-store journey) => unknown.
        const seg =
          o.customerOrderIndex === 1
            ? "new"
            : o.customerOrderIndex > 1
            ? "repeat"
            : "unknown";

        const { key, label } = bucketFor(o.createdAt, cfg.granularity, cfg.timeZone);
        let b = bucketMap.get(key);
        if (!b) {
          b = { key, label, ...emptySegmentedTotals() };
          bucketMap.set(key, b);
        }
        addSegmented(b, o, seg);
        addSegmented(totals, o, seg);

        // Discount tallies (per bucket + window totals + per-code mix).
        const hasCode = o.discountCodes.length > 0;
        const isDiscounted = o.totalDiscounts > 0 || hasCode;
        if (hasCode) {
          b.codeOrders += 1;
          totals.codeOrders += 1;
          // Roll codes up into their group (REW-* -> loyalty) then de-dupe within
          // the order so one order counts once per group. `byKey` keeps per-period
          // order counts so the code table can show period-over-period movement.
          const grouped = new Set(o.discountCodes.map(groupDiscountCode));
          for (const code of grouped) {
            let c = codeMap.get(code);
            if (!c) {
              c = { code, orders: 0, sales: 0, discountAmount: 0, byKey: {} };
              codeMap.set(code, c);
            }
            c.orders += 1;
            c.sales += o.sales;
            c.discountAmount += o.totalDiscounts;
            // Per-period order count + discount amount, so the code table can show
            // period-over-period deltas for each of its metrics.
            const cell = c.byKey[key] || (c.byKey[key] = { orders: 0, amount: 0 });
            cell.orders += 1;
            cell.amount += o.totalDiscounts;
          }
        }
        if (isDiscounted) {
          b.discountedOrders += 1;
          b.discountAmount += o.totalDiscounts;
          totals.discountedOrders += 1;
          totals.discountAmount += o.totalDiscounts;
        }

        if (landingMap) {
          const lpPath = normalizePath(pathFromUrl(o.landingPage));
          if (lpPath) {
            landingWithPath += 1;
            let lp = landingMap.get(lpPath);
            if (!lp) {
              lp = { path: lpPath, units: 0, transactions: 0, sales: 0, upsellUnits: 0, upsellOrders: 0 };
              landingMap.set(lpPath, lp);
            }
            lp.units += o.units;
            lp.transactions += 1;
            lp.sales += o.sales;
            lp.upsellUnits += o.upsellUnits;
            lp.upsellOrders += o.hasUpsell ? 1 : 0;
          }
        }
      }

      const buckets = [...bucketMap.values()]
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((b) => ({
          ...roundSegmentedSales(b),
          value: round(metricDef.value(b), metricDef.decimals),
        }));

      // Discount-code mix rows, ordered by order count desc.
      const codes = [...codeMap.values()]
        .map((c) => ({
          ...c,
          sales: round(c.sales, 2),
          discountAmount: round(c.discountAmount, 2),
        }))
        .sort((a, b) => b.orders - a.orders);

      // Per-landing-page rows (ordered by transactions desc), each carrying the
      // metric value so the UI can show UPT per page honoring the same exclusions.
      const landingPages = landingMap
        ? [...landingMap.values()]
            .map((lp) => ({
              ...lp,
              sales: round(lp.sales, 2),
              value: round(metricDef.value(lp), metricDef.decimals),
            }))
            .sort((a, b) => b.transactions - a.transactions)
        : undefined;

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
          ...roundSegmentedSales(totals),
          value: round(metricDef.value(totals), metricDef.decimals),
        },
        // Discount-code mix over the window. Percentages are derived in the UI:
        //   ordersWithCode / totalOrders    -> code-usage penetration
        //   discountedOrders / totalOrders  -> overall discount penetration
        //   code.orders / ordersWithCode    -> share of code-using orders
        //   code.orders / discountedOrders  -> share of all discounted orders
        // Note: an order with multiple codes counts toward each code, so the
        // per-code shares of ordersWithCode can sum to slightly over 100%.
        discounts: {
          totalOrders: ordersMatched,
          ordersWithCode: totals.codeOrders,
          discountedOrders: totals.discountedOrders,
          discountAmount: round(totals.discountAmount, 2),
          codes,
        },
        ...(landingPages
          ? { landingPages, landingCoverage: { withPath: landingWithPath, matched: ordersMatched } }
          : {}),
        onlineStoreOnly,
        diagnostics: { ordersScanned: orders.size, ordersMatched, excludedNonOnlineStore },
      };
    },
  };
}

// Array-of-orders convenience (used by tests and any non-bulk path).
export function computeMetric(orders, cfg) {
  const acc = createAccumulator(cfg);
  for (const order of orders) {
    acc.addOrder(order.id, order.createdAt, orderMetaOf(order));
    for (const li of order.lineItems?.nodes || []) {
      acc.addLineItem(order.id, li);
    }
  }
  return acc.finalize();
}
