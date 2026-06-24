// UPT trend diagnosis.
//
// Pure functions, no I/O — fed the per-period buckets returned by the metric
// engine (lib/metrics.js) and classifies the trend:
//   * direction  — incline | decline | stable
//   * shape      — sharp (a step change concentrated in one period) | gradual
//                  (sustained drift spread across the window)
//
// Partial edge periods (a leading/trailing week or month the data window only
// partially covers — e.g. the in-progress current week) are detected by period
// coverage, not by volume guessing, and excluded from the trend so they don't
// drag the verdict. They're still returned (flagged) for charting.
//
// Thresholds are deliberately explicit and exported so the UI can show its work
// and they can be tuned without spelunking through the logic.

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

// ---- period-coverage helpers (for partial-edge detection) ----

// Format an ISO timestamp to YYYY-MM-DD in the given IANA timezone. en-CA yields
// ISO-ordered date parts, so the result is directly string-comparable.
function tzDate(iso, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  } catch {
    return String(iso).slice(0, 10);
  }
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function lastOfMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // day 0 of next month
}

// The calendar span a bucket key represents, per granularity. Keys come from
// lib/metrics.js: day = YYYY-MM-DD, week = Monday YYYY-MM-DD, month = YYYY-MM.
function periodBounds(key, granularity) {
  if (granularity === "month") return { start: `${key}-01`, end: lastOfMonth(key) };
  if (granularity === "week") return { start: key, end: addDays(key, 6) };
  return { start: key, end: key };
}

// `buckets` is the metrics-engine output: [{ key, label, value, transactions, ... }].
// `value` is the metric (UPT) for that period. opts:
//   flatPct/sharpStepPct/sharpConcentration — override DIAGNOSIS_DEFAULTS
//   granularity, timeZone, windowStart, windowEnd, dropPartial — partial-edge
//     handling. When dropPartial (default true) and the window context is given,
//     a leading/trailing bucket the window only partially covers is flagged
//     `partial` and excluded from the trend computation.
export function diagnoseTrend(buckets, opts = {}) {
  const t = { ...DIAGNOSIS_DEFAULTS, ...opts };
  const dropPartial = opts.dropPartial !== false;

  // Keep only periods with data, in chronological order (engine already sorts).
  const points = (buckets || [])
    .filter((b) => isFiniteNum(b.value) && (b.transactions || 0) > 0)
    .map((b) => ({
      label: b.label,
      key: b.key,
      value: b.value,
      transactions: b.transactions,
      partial: false,
    }));

  // Flag partial edge periods by coverage: a bucket is partial when the data
  // window doesn't span its whole calendar period.
  let partialCount = 0;
  if (dropPartial && opts.windowStart && opts.windowEnd && opts.granularity && points.length) {
    const winStart = tzDate(opts.windowStart, opts.timeZone);
    const winEnd = tzDate(opts.windowEnd, opts.timeZone);
    const first = points[0];
    const last = points[points.length - 1];
    if (periodBounds(first.key, opts.granularity).start < winStart) {
      first.partial = true;
    }
    if (periodBounds(last.key, opts.granularity).end > winEnd) {
      last.partial = true;
    }
    partialCount = points.filter((p) => p.partial).length;
  }

  // Trend is computed on the fully-covered periods only.
  const trend = points.filter((p) => !p.partial);

  if (trend.length < 2) {
    return {
      ok: false,
      reason:
        partialCount > 0
          ? "Not enough complete periods to diagnose a trend after dropping partial edges (need at least 2)."
          : "Not enough periods with data to diagnose a trend (need at least 2).",
      points,
      partialCount,
    };
  }

  const values = trend.map((p) => p.value);
  const n = values.length;
  const first = values[0];
  const last = values[n - 1];
  const netChange = last - first;
  const netPct = first !== 0 ? netChange / first : netChange === 0 ? 0 : Infinity;

  const { slope, intercept, r2 } = linearFit(values);
  const fittedChange = slope * (n - 1);
  const fittedPct = first !== 0 ? fittedChange / first : 0;

  // Period-over-period deltas and the single biggest one.
  const steps = [];
  let totalAbsMovement = 0;
  let biggest = { index: 0, delta: 0, pct: 0, from: null, to: null };
  for (let i = 1; i < n; i++) {
    const delta = values[i] - values[i - 1];
    const pct = values[i - 1] !== 0 ? delta / values[i - 1] : 0;
    steps.push({ from: trend[i - 1].label, to: trend[i].label, delta, pct });
    totalAbsMovement += Math.abs(delta);
    if (Math.abs(delta) > Math.abs(biggest.delta)) {
      biggest = { index: i, delta, pct, from: trend[i - 1].label, to: trend[i].label };
    }
  }
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
  const partialNote =
    partialCount > 0
      ? ` (${partialCount} partial edge period${partialCount > 1 ? "s" : ""} excluded)`
      : "";
  let headline;
  let detail;
  if (direction === "stable") {
    headline = "UPT is stable";
    detail = `UPT ${verb} (${pctStr} net change over ${n} complete periods), within the ±${(t.flatPct * 100).toFixed(0)}% flat band${partialNote}.`;
  } else if (isSharp) {
    headline = `Sharp ${direction} in UPT`;
    detail = `UPT ${verb} ${pctStr} overall, but ${(concentration * 100).toFixed(0)}% of the move happened in a single period — ${biggest.from} → ${biggest.to}, a ${(Math.abs(biggest.pct) * 100).toFixed(1)}% ${biggest.delta >= 0 ? "jump" : "drop"}. This looks like a step change, not a slow drift${partialNote}.`;
  } else {
    headline = `Gradual ${direction} in UPT`;
    detail = `UPT ${verb} ${pctStr} over ${n} complete periods as a sustained drift (no single period dominates; trend fit R²=${r2.toFixed(2)}). Roughly ${slope >= 0 ? "+" : ""}${slope.toFixed(3)} units/txn per period${partialNote}.`;
  }

  return {
    ok: true,
    direction,
    shape,
    headline,
    detail,
    points, // all data periods, each with a `partial` flag (for charting)
    partialCount,
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
