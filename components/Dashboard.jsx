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
          </>
        ) : (
          <p className="meta">Set your parameters and hit “Run”.</p>
        )}
      </section>
    </div>
  );
}
