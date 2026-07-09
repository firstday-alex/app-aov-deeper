// Timezone helpers shared by the client (window construction) and server.
//
// Orders carry a UTC `createdAt`, but merchants think in their store's local
// calendar days. These helpers convert a local day range (YYYY-MM-DD, inclusive)
// in a given IANA timezone into the UTC instant bounds that bracket it, so the
// orders `created_at` filter and the day bucketing agree on where a day starts.

// Offset (ms) of `timeZone` at the instant `utcMs`: (wall-clock as-if-UTC) - utc.
function tzOffsetMs(timeZone, utcMs) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = dtf.formatToParts(new Date(utcMs)).reduce((a, x) => {
    a[x.type] = x.value;
    return a;
  }, {});
  let hour = Number(p.hour);
  if (hour === 24) hour = 0; // some engines render midnight as 24
  const asUTC = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    hour,
    Number(p.minute),
    Number(p.second)
  );
  return asUTC - utcMs;
}

// The UTC ISO string for a wall-clock time (`YYYY-MM-DD`, `HH:mm:ss.SSS`) in
// `timeZone`. One-pass offset correction — the only imprecision is a wall time
// that lands exactly inside a DST transition, which never happens for the
// 00:00 / 23:59:59.999 bounds we use here.
function zonedWallTimeToUtc(dateStr, timeStr, timeZone) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [h = "0", mi = "0", secPart = "0"] = timeStr.split(":");
  const [s = "0", ms = "0"] = secPart.split(".");
  const wallAsUtc = Date.UTC(y, mo - 1, d, Number(h), Number(mi), Number(s), Number(ms));
  const off = tzOffsetMs(timeZone, wallAsUtc);
  return new Date(wallAsUtc - off).toISOString();
}

// Convert an inclusive local day range to UTC instant bounds. Falls back to
// plain UTC-midnight bounds when no timezone (or UTC) is given.
export function zonedDayRangeToUtc(startDate, endDate, timeZone) {
  if (!timeZone || timeZone === "UTC") {
    return {
      start: `${startDate}T00:00:00.000Z`,
      end: `${endDate}T23:59:59.999Z`,
    };
  }
  try {
    return {
      start: zonedWallTimeToUtc(startDate, "00:00:00.000", timeZone),
      end: zonedWallTimeToUtc(endDate, "23:59:59.999", timeZone),
    };
  } catch {
    // Invalid IANA name — degrade to UTC rather than throw in the UI.
    return {
      start: `${startDate}T00:00:00.000Z`,
      end: `${endDate}T23:59:59.999Z`,
    };
  }
}
