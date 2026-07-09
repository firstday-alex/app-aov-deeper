"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoStr(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nf(n, decimals = 2) {
  return Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

// Share of `d` as a percent string, guarding division by zero.
function pct(n, d, decimals = 1) {
  if (!d) return "—";
  return `${((Number(n || 0) / d) * 100).toFixed(decimals)}%`;
}

export default function Dashboard() {
  const [config, setConfig] = useState(null);
  const [metrics, setMetrics] = useState([]);
  const [persistenceMode, setPersistenceMode] = useState("memory");

  const [startDate, setStartDate] = useState(daysAgoStr(30));
  const [endDate, setEndDate] = useState(todayStr());

  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [savedMsg, setSavedMsg] = useState("");

  // Load persisted defaults.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/config");
        const data = await res.json();
        setConfig(data.config);
        setMetrics(data.metrics || []);
        setPersistenceMode(data.persistenceMode);
        setStartDate(daysAgoStr(data.config.lookbackDays));
        setEndDate(todayStr());
      } catch (e) {
        setError("Could not load configuration.");
      }
    })();
  }, []);

  function update(key, value) {
    setConfig((c) => ({ ...c, [key]: value }));
  }

  // Submit a bulk export, poll until it completes, then aggregate the result.
  async function runMetric() {
    if (!config) return;
    setRunning(true);
    setError(null);
    setStatusMsg("Submitting export…");

    const window = {
      start: `${startDate}T00:00:00.000Z`,
      end: `${endDate}T23:59:59.999Z`,
    };

    try {
      // 1) start (or reuse a cached completed export)
      const startRes = await fetch("/api/metric/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config, ...window }),
      });
      const startData = await startRes.json();
      if (!startRes.ok) throw new Error(startData.error || "Failed to start export");
      const { opId, cached } = startData;
      const win = startData.window || window;

      // 2) poll until COMPLETED (skip if cached/already complete)
      if (cached) {
        setStatusMsg("Reusing recent export…");
      } else {
        for (;;) {
          await sleep(1500);
          const pollRes = await fetch(`/api/metric/poll?id=${encodeURIComponent(opId)}`);
          const poll = await pollRes.json();
          if (!pollRes.ok) throw new Error(poll.error || "Poll failed");
          if (poll.status === "COMPLETED") break;
          if (["FAILED", "CANCELED", "EXPIRED"].includes(poll.status)) {
            throw new Error(`Export ${poll.status.toLowerCase()}${poll.errorCode ? `: ${poll.errorCode}` : ""}`);
          }
          setStatusMsg(`Shopify processing… ${Number(poll.objectCount || 0).toLocaleString()} objects`);
        }
      }

      // 3) aggregate
      setStatusMsg("Aggregating results…");
      const resRes = await fetch("/api/metric/result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opId, config, window: win }),
      });
      const data = await resRes.json();
      if (!resRes.ok) throw new Error(data.error || "Failed to aggregate");
      setResult(data);
      setStatusMsg("");
    } catch (e) {
      setError(e.message);
      setResult(null);
      setStatusMsg("");
    } finally {
      setRunning(false);
    }
  }

  async function saveDefaults() {
    if (!config) return;
    setSavedMsg("");
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      setConfig(data.config);
      setSavedMsg(
        data.persistenceMode === "kv"
          ? "Saved as defaults."
          : "Saved (in-memory only — configure KV to persist)."
      );
    } catch (e) {
      setError(e.message);
    }
  }

  const chartData = useMemo(
    () =>
      (result?.buckets || []).map((b) => ({
        name: b.label,
        value: b.value,
        units: b.units,
        transactions: b.transactions,
      })),
    [result]
  );

  // New-vs-repeat transactions per period (stacked). "Unknown" = orders Shopify
  // hasn't attributed a customer order index to.
  const newRepeatData = useMemo(
    () =>
      (result?.buckets || []).map((b) => ({
        name: b.label,
        "New": b.newTransactions || 0,
        "Repeat": b.repeatTransactions || 0,
        "Unknown": b.unknownTransactions || 0,
      })),
    [result]
  );

  const hasUnknownSeg = useMemo(
    () => (result?.buckets || []).some((b) => (b.unknownTransactions || 0) > 0),
    [result]
  );

  // Share of orders that are new vs repeat, per period (0–100).
  const newRepeatPctData = useMemo(
    () =>
      (result?.buckets || []).map((b) => {
        const t = b.transactions || 0;
        const p = (n) => (t ? +(((n || 0) / t) * 100).toFixed(1) : 0);
        return {
          name: b.label,
          "% New": p(b.newTransactions),
          "% Repeat": p(b.repeatTransactions),
          "% Unknown": p(b.unknownTransactions),
        };
      }),
    [result]
  );

  // AOV split by new vs repeat, per period. null (gap in the line) when a segment
  // had no orders that period.
  const segAovData = useMemo(
    () =>
      (result?.buckets || []).map((b) => ({
        name: b.label,
        "New AOV": b.newTransactions ? +(b.newSales / b.newTransactions).toFixed(2) : null,
        "Repeat AOV": b.repeatTransactions
          ? +(b.repeatSales / b.repeatTransactions).toFixed(2)
          : null,
      })),
    [result]
  );

  // Discount penetration per period (0–100): code-usage and any-discount rates.
  const discountPoPData = useMemo(
    () =>
      (result?.buckets || []).map((b) => {
        const t = b.transactions || 0;
        const p = (n) => (t ? +(((n || 0) / t) * 100).toFixed(1) : 0);
        return {
          name: b.label,
          "Code %": p(b.codeOrders),
          "Discount %": p(b.discountedOrders),
        };
      }),
    [result]
  );

  const discounts = result?.discounts || null;

  if (!config) {
    return <div className="panel">Loading configuration…</div>;
  }

  const metricUnit = result?.metric?.unit || "";
  const isMoney = Boolean(result?.metric?.money);
  const currency = result?.currency || "";

  // Headline metric value: money metrics get a currency prefix + 2 decimals.
  const headlineValue = result
    ? isMoney
      ? `${currency ? currency + " " : ""}${nf(result.totals.value, 2)}`
      : nf(result.totals.value, 2)
    : "";
  const headlineUnit = isMoney ? metricUnit.replace(/^\//, "per ") : metricUnit;

  return (
    <div className="layout">
      {/* ---------------- Control panel ---------------- */}
      <aside className="panel">
        <h2>Parameters</h2>

        <div className="field">
          <label>Metric</label>
          <select value={config.metric} onChange={(e) => update("metric", e.target.value)}>
            {metrics.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>Sales basis (AOV &amp; net sales metrics)</label>
          <select value={config.salesBasis} onChange={(e) => update("salesBasis", e.target.value)}>
            <option value="net">Net of discounts (excl. tax &amp; shipping)</option>
            <option value="gross">Gross (before discounts)</option>
            <option value="netWithTax">Net + tax (excl. shipping)</option>
          </select>
        </div>

        <div className="field">
          <label>Date range</label>
          <div className="row">
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
        </div>

        <div className="field">
          <label>Group by</label>
          <select value={config.granularity} onChange={(e) => update("granularity", e.target.value)}>
            <option value="day">Day</option>
            <option value="week">Week (Mon-based)</option>
            <option value="month">Month</option>
          </select>
        </div>

        <div className="field">
          <label>Timezone (IANA) for bucketing</label>
          <input
            value={config.timeZone}
            onChange={(e) => update("timeZone", e.target.value)}
            placeholder="UTC"
          />
        </div>

        <div className="field">
          <label>Exclude line items containing (one per line / comma-separated)</label>
          <textarea
            value={
              Array.isArray(config.excludeNames)
                ? config.excludeNames.join("\n")
                : config.excludeNames
            }
            onChange={(e) => update("excludeNames", e.target.value)}
            placeholder="rapid hydration"
          />
        </div>

        <div className="field">
          <label>Upsell line-item property key (optional)</label>
          <input
            value={config.upsellPropertyKey}
            onChange={(e) => update("upsellPropertyKey", e.target.value)}
            placeholder="_upsell"
          />
        </div>

        <div className="field">
          <label>Upsell property values (one per line / comma-separated; blank = any value)</label>
          <textarea
            value={
              Array.isArray(config.upsellPropertyValues)
                ? config.upsellPropertyValues.join("\n")
                : config.upsellPropertyValues
            }
            onChange={(e) => update("upsellPropertyValues", e.target.value)}
            placeholder={"cart-drawer\npdp-widget"}
          />
        </div>

        <div className="field">
          <label>Order landing-page path (optional)</label>
          <input
            value={config.landingPagePath}
            onChange={(e) => update("landingPagePath", e.target.value)}
            placeholder="/pages/offer-a"
          />
        </div>

        <div className="field">
          <label>Path match mode</label>
          <select
            value={config.landingPageMatch}
            onChange={(e) => update("landingPageMatch", e.target.value)}
          >
            <option value="startsWith">Starts with</option>
            <option value="exact">Exact</option>
            <option value="contains">Contains</option>
          </select>
        </div>

        <div className="field checkbox">
          <input
            id="countEmpty"
            type="checkbox"
            checked={config.countEmptyOrders}
            onChange={(e) => update("countEmptyOrders", e.target.checked)}
          />
          <label htmlFor="countEmpty" style={{ margin: 0 }}>
            Count orders with 0 included units as transactions
          </label>
        </div>

        <div className="field checkbox">
          <input
            id="includeTest"
            type="checkbox"
            checked={config.includeTestOrders}
            onChange={(e) => update("includeTestOrders", e.target.checked)}
          />
          <label htmlFor="includeTest" style={{ margin: 0 }}>
            Include test orders
          </label>
        </div>

        <div className="field checkbox">
          <input
            id="onlineStoreOnly"
            type="checkbox"
            checked={config.onlineStoreOnly}
            onChange={(e) => update("onlineStoreOnly", e.target.checked)}
          />
          <label htmlFor="onlineStoreOnly" style={{ margin: 0 }}>
            Online Store orders only (sourceName = web)
          </label>
        </div>

        <div className="actions">
          <button className="primary" onClick={runMetric} disabled={running}>
            {running ? "Running…" : "Run"}
          </button>
          <button onClick={saveDefaults} disabled={running}>
            Save as defaults
          </button>
        </div>
        <div className="toast">{statusMsg || savedMsg}</div>
        <div className="meta">
          Storage:{" "}
          <span className={`badge ${persistenceMode}`}>
            {persistenceMode === "kv" ? "KV (persisted)" : "in-memory"}
          </span>
        </div>
      </aside>

      {/* ---------------- Results ---------------- */}
      <section className="panel">
        <h2>Results</h2>
        {error && <div className="error">{error}</div>}

        {result ? (
          <>
            <div className="kpis">
              <div className="kpi">
                <div className="value">
                  {headlineValue}{" "}
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>{headlineUnit}</span>
                </div>
                <div className="label">{result.metric.label} (period)</div>
              </div>
              <div className="kpi">
                <div className="value">
                  {currency ? currency + " " : ""}
                  {nf(result.totals.sales, 2)}
                </div>
                <div className="label">Net sales</div>
              </div>
              <div className="kpi">
                <div className="value">{result.totals.units.toLocaleString()}</div>
                <div className="label">Included units</div>
              </div>
              <div className="kpi">
                <div className="value">{result.totals.transactions.toLocaleString()}</div>
                <div className="label">Transactions</div>
              </div>
              {config.upsellPropertyKey && (
                <div className="kpi">
                  <div className="value">
                    {Number(result.totals.upsellUnits || 0).toLocaleString()}
                  </div>
                  <div className="label">
                    Upsell units · {Number(result.totals.upsellOrders || 0).toLocaleString()} orders
                  </div>
                </div>
              )}
            </div>

            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 10, right: 16, bottom: 10, left: -10 }}>
                  <CartesianGrid stroke="#263042" strokeDasharray="3 3" />
                  <XAxis dataKey="name" stroke="#8b97a7" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="left" stroke="#8b97a7" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="right" orientation="right" stroke="#3fb98c" tick={{ fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{ background: "#141a24", border: "1px solid #263042", borderRadius: 8 }}
                  />
                  <Legend />
                  <Bar yAxisId="right" dataKey="transactions" name="Transactions" fill="#2a3a52" />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="value"
                    name={result.metric.label}
                    stroke="#5b8def"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <div className="meta">
              Window: {result.window.start.slice(0, 10)} → {result.window.end.slice(0, 10)} ·{" "}
              {Number(result.diagnostics.ordersScanned || 0).toLocaleString()} orders scanned ·{" "}
              {Number(result.diagnostics.ordersMatched || 0).toLocaleString()} matched filters
              {result.fetch?.cached && " · ♻︎ reused recent export"}
              {result.fetch?.empty && " · no orders in window"}
              {result.onlineStoreOnly && (
                <>
                  {" "}· Online Store only ·{" "}
                  {Number(result.diagnostics.excludedNonOnlineStore || 0).toLocaleString()} non-web
                  orders excluded
                </>
              )}
              <br />
              Bulk export ·{" "}
              {Number(result.fetch?.objectCount || 0).toLocaleString()} objects processed
              {typeof result.diagnostics.jsonlLines === "number"
                ? ` · ${result.diagnostics.jsonlLines.toLocaleString()} JSONL rows`
                : ""}
              {isMoney && (
                <>
                  <br />
                  Sales basis: {result.salesBasis} · returns/refunds not subtracted
                </>
              )}
            </div>

            {/* ---------------- New vs Repeat ---------------- */}
            <div className="lp-breakdown">
              <h3>New vs repeat customers · period over period</h3>
              <div className="kpis">
                <div className="kpi">
                  <div className="value">
                    {Number(result.totals.newTransactions || 0).toLocaleString()}
                  </div>
                  <div className="label">
                    New orders · {pct(result.totals.newTransactions, result.totals.transactions)} of orders
                  </div>
                </div>
                <div className="kpi">
                  <div className="value">
                    {Number(result.totals.repeatTransactions || 0).toLocaleString()}
                  </div>
                  <div className="label">
                    Repeat orders ·{" "}
                    {pct(result.totals.repeatTransactions, result.totals.transactions)} of orders
                  </div>
                </div>
                {hasUnknownSeg && (
                  <div className="kpi">
                    <div className="value">
                      {Number(result.totals.unknownTransactions || 0).toLocaleString()}
                    </div>
                    <div className="label">
                      Unattributed · {pct(result.totals.unknownTransactions, result.totals.transactions)}
                    </div>
                  </div>
                )}
              </div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={newRepeatData} margin={{ top: 10, right: 16, bottom: 10, left: -10 }}>
                    <CartesianGrid stroke="#263042" strokeDasharray="3 3" />
                    <XAxis dataKey="name" stroke="#8b97a7" tick={{ fontSize: 11 }} />
                    <YAxis stroke="#8b97a7" tick={{ fontSize: 11 }} />
                    <Tooltip
                      contentStyle={{ background: "#141a24", border: "1px solid #263042", borderRadius: 8 }}
                    />
                    <Legend />
                    <Bar dataKey="New" stackId="seg" fill="#3fb98c" />
                    <Bar dataKey="Repeat" stackId="seg" fill="#5b8def" />
                    {hasUnknownSeg && <Bar dataKey="Unknown" stackId="seg" fill="#4b5566" />}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              <h4 style={{ margin: "16px 0 6px", fontSize: 13, color: "var(--muted)" }}>
                Share of orders · % new vs repeat, period over period
              </h4>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={newRepeatPctData} margin={{ top: 10, right: 16, bottom: 10, left: -10 }}>
                    <CartesianGrid stroke="#263042" strokeDasharray="3 3" />
                    <XAxis dataKey="name" stroke="#8b97a7" tick={{ fontSize: 11 }} />
                    <YAxis stroke="#8b97a7" tick={{ fontSize: 11 }} domain={[0, 100]} unit="%" />
                    <Tooltip
                      contentStyle={{ background: "#141a24", border: "1px solid #263042", borderRadius: 8 }}
                      formatter={(v) => `${v}%`}
                    />
                    <Legend />
                    <Line type="monotone" dataKey="% New" stroke="#3fb98c" strokeWidth={2} dot={{ r: 2 }} />
                    <Line type="monotone" dataKey="% Repeat" stroke="#5b8def" strokeWidth={2} dot={{ r: 2 }} />
                    {hasUnknownSeg && (
                      <Line type="monotone" dataKey="% Unknown" stroke="#8b97a7" strokeWidth={1.5} strokeDasharray="3 3" dot={false} />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              <h4 style={{ margin: "16px 0 6px", fontSize: 13, color: "var(--muted)" }}>
                AOV · new vs repeat, period over period{currency ? ` (${currency})` : ""}
              </h4>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={segAovData} margin={{ top: 10, right: 16, bottom: 10, left: -10 }}>
                    <CartesianGrid stroke="#263042" strokeDasharray="3 3" />
                    <XAxis dataKey="name" stroke="#8b97a7" tick={{ fontSize: 11 }} />
                    <YAxis stroke="#8b97a7" tick={{ fontSize: 11 }} domain={["auto", "auto"]} />
                    <Tooltip
                      contentStyle={{ background: "#141a24", border: "1px solid #263042", borderRadius: 8 }}
                    />
                    <Legend />
                    <Line type="monotone" dataKey="New AOV" stroke="#3fb98c" strokeWidth={2} dot={{ r: 2 }} connectNulls />
                    <Line type="monotone" dataKey="Repeat AOV" stroke="#5b8def" strokeWidth={2} dot={{ r: 2 }} connectNulls />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              <div className="meta">
                New = customer's first order (customerOrderIndex 1); repeat = a prior order exists
                (index &gt; 1). Test orders are never counted in the index.
                {hasUnknownSeg &&
                  " Unattributed orders have no customer order index yet (attribution pending or no online-store journey)."}
              </div>
            </div>

            {/* ---------------- Discount code mix ---------------- */}
            {discounts && (
              <div className="lp-breakdown">
                <h3>Discount code mix</h3>
                <div className="kpis">
                  <div className="kpi">
                    <div className="value">
                      {pct(discounts.ordersWithCode, discounts.totalOrders)}
                    </div>
                    <div className="label">
                      Orders using a code ·{" "}
                      {Number(discounts.ordersWithCode || 0).toLocaleString()} of{" "}
                      {Number(discounts.totalOrders || 0).toLocaleString()}
                    </div>
                  </div>
                  <div className="kpi">
                    <div className="value">
                      {pct(discounts.discountedOrders, discounts.totalOrders)}
                    </div>
                    <div className="label">
                      Discounted orders (incl. automatic) ·{" "}
                      {Number(discounts.discountedOrders || 0).toLocaleString()} of{" "}
                      {Number(discounts.totalOrders || 0).toLocaleString()}
                    </div>
                  </div>
                  <div className="kpi">
                    <div className="value">{(discounts.codes || []).length.toLocaleString()}</div>
                    <div className="label">Distinct codes used</div>
                  </div>
                </div>

                <h4 style={{ margin: "16px 0 6px", fontSize: 13, color: "var(--muted)" }}>
                  Discount penetration · period over period
                </h4>
                <div className="chart-wrap">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={discountPoPData} margin={{ top: 10, right: 16, bottom: 10, left: -10 }}>
                      <CartesianGrid stroke="#263042" strokeDasharray="3 3" />
                      <XAxis dataKey="name" stroke="#8b97a7" tick={{ fontSize: 11 }} />
                      <YAxis stroke="#8b97a7" tick={{ fontSize: 11 }} domain={[0, "auto"]} unit="%" />
                      <Tooltip
                        contentStyle={{ background: "#141a24", border: "1px solid #263042", borderRadius: 8 }}
                        formatter={(v) => `${v}%`}
                      />
                      <Legend />
                      <Line type="monotone" dataKey="Discount %" stroke="#e0a63f" strokeWidth={2} dot={{ r: 2 }} />
                      <Line type="monotone" dataKey="Code %" stroke="#5b8def" strokeWidth={2} dot={{ r: 2 }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>

                {discounts.codes && discounts.codes.length ? (
                  <>
                    <div className="lp-table-wrap">
                      <table className="lp-table">
                        <thead>
                          <tr>
                            <th>Discount code</th>
                            <th className="num">Orders</th>
                            <th className="num">% of code orders</th>
                            <th className="num">% of discounted orders</th>
                            <th className="num">% of all orders</th>
                            <th className="num">Discount {currency && `(${currency})`}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {discounts.codes.map((c) => (
                            <tr key={c.code}>
                              <td className="path" title={c.code}>{c.code}</td>
                              <td className="num">{c.orders.toLocaleString()}</td>
                              <td className="num">{pct(c.orders, discounts.ordersWithCode)}</td>
                              <td className="num">{pct(c.orders, discounts.discountedOrders)}</td>
                              <td className="num">{pct(c.orders, discounts.totalOrders)}</td>
                              <td className="num">{nf(c.discountAmount, 2)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="meta">
                      “% of code orders” = code’s orders ÷ orders that used any code; “% of discounted
                      orders” also counts code-free (automatic) discounts in the denominator. An order
                      with multiple codes counts toward each, so “% of code orders” can sum to slightly
                      over 100%.
                    </div>
                  </>
                ) : (
                  <p className="meta">No discount codes were used on orders in this window.</p>
                )}
              </div>
            )}
          </>
        ) : (
          <p className="meta">Set your parameters and hit “Run”.</p>
        )}
      </section>
    </div>
  );
}
