// UPT trend diagnosis.
//
// Pure functions, no I/O — fed the per-period buckets returned by the metric
// engine (lib/metrics.js) and classifies the trend:
//   * direction  — incline | decline | stable
//   * shape      — sharp (a step change concentrated in one period) | gradual
//                  (sustained drift spread across the window)
//
// The thresholds are deliberately explicit and exported so the UI can show its
// work and they can be tuned without spelunking through the logic.

export const DIAGNOSIS_DEFAULTS = {
  // Net change below this (relative to the starting level) is treated as flat —
  // i.e. neither a meaningful incline nor decline.
  flatPct: 0.03, // 3%
  // A single period whose move (relative to the prior level) is at least this
  // large is a candidate "shock".
  sharpStepPct: 0.1, // 10%
  // ...and it's only "sharp" if that one period accounts for at least this share
  // of all the movement in the window (otherwise the swing is just noise atop a
  // broader drift, which reads as gradual/volatile).
  sharpConcentration: 0.6, // 60%
};

function isFiniteNum(n) {
  return typeof n === "number" && Number.isFinite(n);
}

// Least-squares fit of value against period index (0,1,2,…). Returns the slope
// (metric units per period), the intercept, and R² (how much of the variance the
// straight-line trend explains — a proxy for "how sustained / monotonic").
function linearFit(values) {
  const n = values.length;
  const xs = values.map((_, i) => i);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = values[i] - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;
  const r2 = syy === 0 || sxx === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2 };
}

// `buckets` is the metrics-engine output: [{ key, label, value, transactions, ... }].
// `value` is the metric (UPT) for that period. We diagnose the shape of `value`
// over time. opts overrides the DIAGNOSIS_DEFAULTS thresholds.
export function diagnoseTrend(buckets, opts = {}) {
  const t = { ...DIAGNOSIS_DEFAULTS, ...opts };

  // Keep only periods with data, in chronological order (engine already sorts).
  const points = (buckets || [])
    .filter((b) => isFiniteNum(b.value) && (b.transactions || 0) > 0)
    .map((b) => ({ label: b.label, key: b.key, value: b.value, transactions: b.transactions }));

  if (points.length < 2) {
    return {
      ok: false,
      reason: "Not enough periods with data to diagnose a trend (need at least 2).",
      points,
    };
  }

  const values = points.map((p) => p.value);
  const n = values.length;
  const first = values[0];
  const last = values[n - 1];
  const netChange = last - first;
  const netPct = first !== 0 ? netChange / first : netChange === 0 ? 0 : Infinity;

  const { slope, intercept, r2 } = linearFit(values);
  // Total change the fitted line implies across the window, as a % of the start.
  const fittedChange = slope * (n - 1);
  const fittedPct = first !== 0 ? fittedChange / first : 0;

  // Period-over-period deltas and the single biggest one.
  const steps = [];
  let totalAbsMovement = 0;
  let biggest = { index: 0, delta: 0, pct: 0 };
  for (let i = 1; i < n; i++) {
    const delta = values[i] - values[i - 1];
    const pct = values[i - 1] !== 0 ? delta / values[i - 1] : 0;
    steps.push({ from: points[i - 1].label, to: points[i].label, delta, pct });
    totalAbsMovement += Math.abs(delta);
    if (Math.abs(delta) > Math.abs(biggest.delta)) {
      biggest = { index: i, delta, pct, from: points[i - 1].label, to: points[i].label };
    }
  }
  // Share of all movement concentrated in the single biggest step.
  const concentration = totalAbsMovement > 0 ? Math.abs(biggest.delta) / totalAbsMovement : 0;

  // ---- direction ----
  let direction;
  if (Math.abs(netPct) < t.flatPct && Math.abs(fittedPct) < t.flatPct) {
    direction = "stable";
  } else {
    direction = netChange >= 0 ? "incline" : "decline";
  }

  // ---- shape (only meaningful when not stable) ----
  const stepIsBig = Math.abs(biggest.pct) >= t.sharpStepPct;
  const stepDominates = concentration >= t.sharpConcentration;
  const isSharp = direction !== "stable" && stepIsBig && stepDominates;
  const shape = direction === "stable" ? "stable" : isSharp ? "sharp" : "gradual";

  // ---- headline + explanation ----
  const verb =
    direction === "incline" ? "rose" : direction === "decline" ? "fell" : "held roughly flat";
  const pctStr = `${Math.abs(netPct * 100).toFixed(1)}%`;
  let headline;
  let detail;
  if (direction === "stable") {
    headline = "UPT is stable";
    detail = `UPT ${verb} (${pctStr} net change over ${n} periods), within the ±${(t.flatPct * 100).toFixed(0)}% flat band.`;
  } else if (isSharp) {
    headline = `Sharp ${direction === "incline" ? "incline" : "decline"} in UPT`;
    detail = `UPT ${verb} ${pctStr} overall, but ${(concentration * 100).toFixed(0)}% of the move happened in a single period — ${biggest.from} → ${biggest.to}, a ${(Math.abs(biggest.pct) * 100).toFixed(1)}% ${biggest.delta >= 0 ? "jump" : "drop"}. This looks like a step change, not a slow drift.`;
  } else {
    headline = `Gradual ${direction === "incline" ? "incline" : "decline"} in UPT`;
    detail = `UPT ${verb} ${pctStr} over ${n} periods as a sustained drift (no single period dominates; trend fit R²=${r2.toFixed(2)}). Roughly ${slope >= 0 ? "+" : ""}${slope.toFixed(3)} units/txn per period.`;
  }

  return {
    ok: true,
    direction,
    shape,
    headline,
    detail,
    points,
    stats: {
      periods: n,
      first,
      last,
      netChange,
      netPct,
      slopePerPeriod: slope,
      intercept,
      r2,
      concentration,
      biggestStep: biggest,
      steps,
      totalAbsMovement,
    },
    thresholds: t,
  };
}
