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

export default function Dashboard() {
  const [config, setConfig] = useState(null);
  const [metrics, setMetrics] = useState([]);
  const [persistenceMode, setPersistenceMode] = useState("memory");

  const [startDate, setStartDate] = useState(daysAgoStr(30));
  const [endDate, setEndDate] = useState(todayStr());

  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
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

  async function runMetric() {
    if (!config) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/metric", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config,
          start: `${startDate}T00:00:00.000Z`,
          end: `${endDate}T23:59:59.999Z`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      setResult(data);
    } catch (e) {
      setError(e.message);
      setResult(null);
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
          <button onClick={saveDefaults}>Save as defaults</button>
        </div>
        <div className="toast">{savedMsg}</div>
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
                  {result.totals.value} <span style={{ fontSize: 12, color: "var(--muted)" }}>{metricUnit}</span>
                </div>
                <div className="label">{result.metric.label} (period total)</div>
              </div>
              <div className="kpi">
                <div className="value">{result.totals.units.toLocaleString()}</div>
                <div className="label">Included units</div>
              </div>
              <div className="kpi">
                <div className="value">{result.totals.transactions.toLocaleString()}</div>
                <div className="label">Transactions</div>
              </div>
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
              {result.fetch.ordersFetched} orders fetched ({result.fetch.pages} page
              {result.fetch.pages === 1 ? "" : "s"}) · {result.diagnostics.ordersMatched} matched filters
              {result.fetch.capped && " · ⚠️ result capped at fetch limit"}
              <br />
              Shopify query: <code>{result.fetch.queryString}</code>
            </div>
          </>
        ) : (
          <p className="meta">Set your parameters and hit “Run”.</p>
        )}
      </section>
    </div>
  );
}
