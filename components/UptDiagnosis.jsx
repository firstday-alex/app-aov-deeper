"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Bar,
  ReferenceDot,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { diagnoseTrend } from "@/lib/diagnose";

// Product titles excluded from the UPT calculation by default. Matching is a
// case-insensitive substring test (see lib/metrics.js), so "Gift" already covers
// "GIFT"/"gift" — we keep the user's full list visible and editable regardless.
const DEFAULT_EXCLUSIONS = ["Gift", "GIFT", "FREE", "Free", "Upgrade", "Package Protection"];

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

export default function UptDiagnosis() {
  // The diagnosis view drives its own config: metric is locked to UPT, weekly
  // granularity over a 90-day window reads trend better than noisy daily data,
  // and the exclusion list is pre-loaded with the gift/free/upgrade items.
  const [base, setBase] = useState(null); // timezone / salesBasis / test-order defaults
  const [granularity, setGranularity] = useState("week");
  const [salesBasis, setSalesBasis] = useState("net");
  const [timeZone, setTimeZone] = useState("UTC");
  const [includeTestOrders, setIncludeTestOrders] = useState(false);
  const [excludeText, setExcludeText] = useState(DEFAULT_EXCLUSIONS.join("\n"));

  const [startDate, setStartDate] = useState(daysAgoStr(90));
  const [endDate, setEndDate] = useState(todayStr());

  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");

  // Pull store-level defaults (timezone, sales basis) so diagnosis matches the
  // explorer, but keep this view's metric/filters independent.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/config");
        const data = await res.json();
        const c = data.config || {};
        setBase(c);
        if (c.timeZone) setTimeZone(c.timeZone);
        if (c.salesBasis) setSalesBasis(c.salesBasis);
        setIncludeTestOrders(Boolean(c.includeTestOrders));
      } catch {
        setBase({}); // fall back to local defaults; still usable
      }
    })();
  }, []);

  function buildConfig() {
    return {
      ...(base || {}),
      metric: "upt",
      salesBasis,
      granularity,
      timeZone,
      includeTestOrders,
      excludeNames: excludeText, // normalizeConfig splits on newline/comma server-side
      // diagnosis ignores landing-page / upsell filters
      landingPagePath: "",
      upsellPropertyKey: "",
    };
  }

  async function runDiagnosis() {
    setRunning(true);
    setError(null);
    setStatusMsg("Submitting export…");

    const window = {
      start: `${startDate}T00:00:00.000Z`,
      end: `${endDate}T23:59:59.999Z`,
    };
    const config = buildConfig();

    try {
      const startRes = await fetch("/api/metric/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config, ...window }),
      });
      const startData = await startRes.json();
      if (!startRes.ok) throw new Error(startData.error || "Failed to start export");
      const { opId, cached } = startData;
      const win = startData.window || window;

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

      setStatusMsg("Aggregating & diagnosing…");
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

  const diagnosis = useMemo(
    () => (result ? diagnoseTrend(result.buckets) : null),
    [result]
  );

  const chartData = useMemo(
    () =>
      (result?.buckets || []).map((b) => ({
        name: b.label,
        value: b.value,
        transactions: b.transactions,
      })),
    [result]
  );

  // Highlight the single biggest period-over-period move when the trend is sharp.
  const shockDot = useMemo(() => {
    if (!diagnosis?.ok || diagnosis.shape !== "sharp") return null;
    const step = diagnosis.stats.biggestStep;
    const pt = diagnosis.points[step.index];
    return pt ? { name: pt.label, value: pt.value } : null;
  }, [diagnosis]);

  const verdictClass = diagnosis?.ok
    ? `verdict ${diagnosis.direction} ${diagnosis.shape}`
    : "verdict";

  return (
    <div className="layout">
      {/* ---------------- Controls ---------------- */}
      <aside className="panel">
        <h2>UPT Diagnosis</h2>
        <p className="meta" style={{ marginTop: 0 }}>
          Locked to <strong>Units per Transaction</strong>. Detects whether UPT is
          inclining or declining, and whether the move is <em>sharp</em> (a step
          change) or <em>gradual</em> (a sustained drift).
        </p>

        <div className="field">
          <label>Date range</label>
          <div className="row">
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
        </div>

        <div className="field">
          <label>Group by</label>
          <select value={granularity} onChange={(e) => setGranularity(e.target.value)}>
            <option value="day">Day</option>
            <option value="week">Week (Mon-based)</option>
            <option value="month">Month</option>
          </select>
        </div>

        <div className="field">
          <label>Sales basis</label>
          <select value={salesBasis} onChange={(e) => setSalesBasis(e.target.value)}>
            <option value="net">Net of discounts</option>
            <option value="gross">Gross (before discounts)</option>
            <option value="netWithTax">Net + tax</option>
          </select>
        </div>

        <div className="field">
          <label>Timezone (IANA)</label>
          <input value={timeZone} onChange={(e) => setTimeZone(e.target.value)} placeholder="UTC" />
        </div>

        <div className="field">
          <label>
            Exclude products containing (pre-loaded · one per line / comma-separated)
          </label>
          <textarea
            value={excludeText}
            onChange={(e) => setExcludeText(e.target.value)}
            rows={6}
          />
          <div className="actions" style={{ marginTop: 8 }}>
            <button
              type="button"
              onClick={() => setExcludeText(DEFAULT_EXCLUSIONS.join("\n"))}
              disabled={running}
            >
              Reset to defaults
            </button>
          </div>
        </div>

        <div className="field checkbox">
          <input
            id="diagTest"
            type="checkbox"
            checked={includeTestOrders}
            onChange={(e) => setIncludeTestOrders(e.target.checked)}
          />
          <label htmlFor="diagTest" style={{ margin: 0 }}>
            Include test orders
          </label>
        </div>

        <div className="actions">
          <button className="primary" onClick={runDiagnosis} disabled={running}>
            {running ? "Diagnosing…" : "Diagnose UPT"}
          </button>
        </div>
        <div className="toast">{statusMsg}</div>
      </aside>

      {/* ---------------- Diagnosis ---------------- */}
      <section className="panel">
        <h2>Diagnosis</h2>
        {error && <div className="error">{error}</div>}

        {result ? (
          <>
            {diagnosis?.ok ? (
              <div className={verdictClass}>
                <div className="verdict-head">
                  <span className="verdict-icon">
                    {diagnosis.direction === "incline"
                      ? "▲"
                      : diagnosis.direction === "decline"
                      ? "▼"
                      : "▬"}
                  </span>
                  <span className="verdict-title">{diagnosis.headline}</span>
                  <span className={`badge shape-${diagnosis.shape}`}>
                    {diagnosis.shape}
                  </span>
                </div>
                <p className="verdict-detail">{diagnosis.detail}</p>
              </div>
            ) : (
              <div className="verdict">
                <p className="verdict-detail">{diagnosis?.reason || "No diagnosis available."}</p>
              </div>
            )}

            <div className="kpis">
              <div className="kpi">
                <div className="value">
                  {nf(result.totals.value, 2)}{" "}
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>units/txn</span>
                </div>
                <div className="label">UPT (whole window)</div>
              </div>
              {diagnosis?.ok && (
                <>
                  <div className="kpi">
                    <div className="value">{nf(diagnosis.stats.first, 2)}</div>
                    <div className="label">First period</div>
                  </div>
                  <div className="kpi">
                    <div className="value">{nf(diagnosis.stats.last, 2)}</div>
                    <div className="label">Last period</div>
                  </div>
                  <div className="kpi">
                    <div
                      className="value"
                      style={{
                        color:
                          diagnosis.direction === "incline"
                            ? "var(--accent-2)"
                            : diagnosis.direction === "decline"
                            ? "var(--danger)"
                            : "var(--text)",
                      }}
                    >
                      {diagnosis.stats.netChange >= 0 ? "+" : ""}
                      {(diagnosis.stats.netPct * 100).toFixed(1)}%
                    </div>
                    <div className="label">Net change ({diagnosis.stats.periods} periods)</div>
                  </div>
                </>
              )}
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
                  <YAxis yAxisId="left" stroke="#8b97a7" tick={{ fontSize: 11 }} domain={["auto", "auto"]} />
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
                    name="UPT"
                    stroke="#5b8def"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                  {shockDot && (
                    <ReferenceDot
                      yAxisId="left"
                      x={shockDot.name}
                      y={shockDot.value}
                      r={6}
                      fill="#e5534b"
                      stroke="#fff"
                      strokeWidth={1}
                      label={{ value: "shock", position: "top", fill: "#e5534b", fontSize: 11 }}
                    />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {diagnosis?.ok && (
              <div className="meta">
                Trend fit R²={diagnosis.stats.r2.toFixed(2)} · slope{" "}
                {diagnosis.stats.slopePerPeriod >= 0 ? "+" : ""}
                {diagnosis.stats.slopePerPeriod.toFixed(3)} units/txn per {granularity} ·{" "}
                biggest single move concentration {(diagnosis.stats.concentration * 100).toFixed(0)}%
                <br />
                Sharp if a single period moves ≥{(diagnosis.thresholds.sharpStepPct * 100).toFixed(0)}%
                and holds ≥{(diagnosis.thresholds.sharpConcentration * 100).toFixed(0)}% of the
                window's movement; otherwise gradual. Flat band ±
                {(diagnosis.thresholds.flatPct * 100).toFixed(0)}%.
                <br />
                Window: {result.window.start.slice(0, 10)} → {result.window.end.slice(0, 10)} ·{" "}
                {Number(result.diagnostics.ordersMatched || 0).toLocaleString()} orders matched ·{" "}
                excludes: {(buildConfig().excludeNames || "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean).join(", ")}
                {result.fetch?.cached && " · ♻︎ reused recent export"}
              </div>
            )}
          </>
        ) : (
          <p className="meta">
            Pick a window and hit “Diagnose UPT”. The exclusion list is already
            pre-loaded with Gift / FREE / Upgrade / Package Protection.
          </p>
        )}
      </section>
    </div>
  );
}
