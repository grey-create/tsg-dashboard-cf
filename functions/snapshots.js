// Cloudflare Pages Function: /snapshots
// Returns the last two Daily Snapshot rows (today + most recent previous day)
// so the dashboard can compute "+X today" deltas without each client doing
// its own arithmetic.
//
// MONTH-ROLLOVER FIX (2026-07-01):
//   Daily Snapshots are month-CUMULATIVE (each field resets to ~0 on the 1st).
//   On the 1st the most-recent prior row belongs to LAST month and still holds
//   that month's full total, so a raw "today - baseline" is a big negative
//   (e.g. New Sales £1,679 today minus June's £196k). The dashboard was
//   showing those as greyed-out / muted chips.
//
//   Fix: when today and the baseline row are in DIFFERENT months, we replace
//   the baseline with a SYNTHETIC ZERO row stamped with THIS month (date = 1st
//   of the month). So:
//     - the deltas become today's month-to-date figures (today - 0), which are
//       positive and therefore render in colour, not muted;
//     - the baseline the page receives is in the SAME month as today, so any
//       "different month => suppress" logic on the front end doesn't fire.
//   Net effect: on the 1st the chips show this month's build-up from zero, in
//   colour, ignoring the previous month entirely. From the 2nd onward the
//   baseline is a genuine same-month row again, so it's the normal day-vs-
//   yesterday comparison. It self-limits to the 1st.
//
//   `deltasAreMonthToDate: true` is also returned so the front end can label
//   the chips "this month" instead of "today" on the 1st (optional polish).

const AIRTABLE_BASE  = "appiOWhszaVriPxDw";
const SNAPSHOT_TABLE = "tblxPyJfXonP1DMxX";

// Field IDs — same as the aggregator writes
const F = {
  snapshotDate: "fldA0URbKyb4wlxdq",
  monthStart:   "fldrEFhaOzCjR8anP",
  tsgInvoiced:  "fldG10U1kRfavDd20",
  tsgWipDue:    "fldLIibxhQnJjVw9o",
  tsgTotal:     "fldiYAK1ZWej551jo",
  wllInvoiced:  "fldRz2DvY0QM51k42",
  nvInvoiced:   "fldOmczSlLCbfa4DE",
  newSalesVal:  "fldrLt4itXAHhn8kt",
  ordersPlaced: "fldJpYSJFixmmbHRh",
  enquiries:    "fldrc51PxpGOegwYO",
  quotesTotal:  "fldNmAGA3Ep9RRyif",
  lastUpdated:  "fldHYnjz7j7Iwisls",
  // Cumulative counters for the ordered/cancelled breakdown chips.
  // Both go up only; the daily delta on each captures today's gross activity.
  ordersCreatedCumul:   "fldlcXUWjajSVF500",   // number, only-goes-up counter (all SOs created this month)
  ordersCancelledCumul: "fld6AUiOq2m6rLsas", // number, only-goes-up counter (voided SOs created this month)
};

// Every numeric field a snapshot carries — all of them reset with the month.
const NUM_KEYS = [
  "tsgInvoiced","tsgWipDue","tsgTotal","wllInvoiced","nvInvoiced",
  "newSalesVal","ordersPlaced","enquiries","quotesTotal",
  "ordersCreatedCumul","ordersCancelledCumul",
];

export async function onRequest(context) {
  const { env } = context;
  try {
    // Pull the last ~10 rows sorted desc by snapshotDate. We only need today +
    // most recent prior, but a small buffer means weekends / missed runs still
    // resolve cleanly.
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${SNAPSHOT_TABLE}` +
                `?returnFieldsByFieldId=true` +
                `&sort%5B0%5D%5Bfield%5D=${F.snapshotDate}` +
                `&sort%5B0%5D%5Bdirection%5D=desc` +
                `&pageSize=10`;

    const res = await fetch(url, {
      headers: { "Authorization": `Bearer ${env.AIRTABLE_TOKEN}` },
    });
    if (!res.ok) {
      const errText = await res.text();
      return jsonResponse({ error: `Airtable ${res.status}`, detail: errText }, 502);
    }
    const data = await res.json();
    const rows = (data.records || []).map(r => mapRow(r));

    if (rows.length === 0) {
      // No snapshots yet — frontend treats this as "no delta available"
      return jsonResponse({ today: null, baseline: null, deltas: null, deltasAreMonthToDate: false });
    }

    // Today's London date
    const todayLondon = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/London",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());

    let today = null, baseline = null;
    for (const r of rows) {
      if (!today && r.date === todayLondon)       { today = r;    continue; }
      if (today && !baseline && r.date < todayLondon){ baseline = r; break;   }
      // If there's no row for today yet (e.g. before first aggregator run of
      // the day) treat the most recent row as "today" and the next one as
      // baseline. Means deltas show last-run-to-now until the day rolls.
      if (!today)                                  { today = r;    continue; }
      if (today && !baseline)                      { baseline = r; break;    }
    }

    // Month-rollover guard. If the real baseline is in a different month than
    // today, swap it for a synthetic zero row stamped with THIS month, so the
    // deltas read as month-to-date (positive, in colour) and nothing on the
    // front end sees a cross-month baseline.
    const monthChanged = !!(baseline && today && monthOf(today) !== monthOf(baseline));
    const effectiveBaseline = monthChanged ? zeroBaseline(today) : baseline;

    const deltas = effectiveBaseline ? computeDeltas(today, effectiveBaseline) : null;
    return jsonResponse({
      today,
      baseline: effectiveBaseline,
      deltas,
      deltasAreMonthToDate: monthChanged,
    });

  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// The month a snapshot row belongs to. Prefer the Month Start field
// ("YYYY-MM-01"); fall back to the first 7 chars of the date ("YYYY-MM").
function monthOf(row) {
  if (row.monthStart) return String(row.monthStart).slice(0, 7);
  if (row.date)       return String(row.date).slice(0, 7);
  return null;
}

// A zero-valued baseline stamped with today's month, dated the 1st. Used at a
// month rollover so the comparison starts from zero and reads as in-month.
function zeroBaseline(today) {
  const monthStart = today.monthStart || (today.date ? today.date.slice(0, 7) + "-01" : null);
  const b = {
    id:         null,
    date:       monthStart,   // 1st of the current month
    monthStart: monthStart,
    lastUpdated: null,
  };
  for (const k of NUM_KEYS) b[k] = 0;
  return b;
}

function mapRow(r) {
  const f = r.fields || {};
  return {
    id:                   r.id,
    date:                 f[F.snapshotDate]  || null,
    monthStart:           f[F.monthStart]    || null,
    tsgInvoiced:          num(f[F.tsgInvoiced]),
    tsgWipDue:            num(f[F.tsgWipDue]),
    tsgTotal:             num(f[F.tsgTotal]),
    wllInvoiced:          num(f[F.wllInvoiced]),
    nvInvoiced:           num(f[F.nvInvoiced]),
    newSalesVal:          num(f[F.newSalesVal]),
    ordersPlaced:         num(f[F.ordersPlaced]),
    enquiries:            num(f[F.enquiries]),
    quotesTotal:          num(f[F.quotesTotal]),
    ordersCreatedCumul:   num(f[F.ordersCreatedCumul]),
    ordersCancelledCumul: num(f[F.ordersCancelledCumul]),
    lastUpdated:          f[F.lastUpdated]   || null,
  };
}

function computeDeltas(today, baseline) {
  const d = {};
  for (const k of NUM_KEYS) d[k] = +(today[k] - baseline[k]).toFixed(2);
  return d;
}

function num(v) {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
