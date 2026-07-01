// Cloudflare Pages Function: /snapshots
// Returns the last two Daily Snapshot rows (today + most recent previous day)
// so the dashboard can compute "+X today" deltas without each client doing
// its own arithmetic.
//
// MONTH-ROLLOVER FIX (2026-07-01):
//   Daily Snapshots are month-CUMULATIVE (each field resets to ~0 on the 1st).
//   On the first day(s) of a new month the baseline row belongs to the previous
//   month and still holds that month's full total, so today - baseline read as
//   a huge negative (e.g. -£225k invoiced). When today and the baseline are in
//   different months we now treat the baseline as ZERO, so every delta reads as
//   this month's build-up so far (month-to-date) instead of a scary minus. The
//   response carries deltasAreMonthToDate:true so the front end can label the
//   chips "this month" rather than "today".
//
// Response shape:
//   {
//     today:     { date, monthStart, tsgInvoiced, ... },
//     baseline:  { ...same fields, from the most recent day before today, or null },
//     deltas:    { tsgInvoiced, ... }  — today - baseline (or today - 0 at rollover),
//                                        or null when baseline unknown
//     deltasAreMonthToDate: bool       — true when the baseline crossed a month
//                                        boundary, so deltas == month-to-date
//   }

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

// Keys that are month-cumulative (they reset on the 1st). At a month rollover
// the baseline is treated as zero for these so the delta reads as month-to-date.
// This is every numeric field the snapshot carries — all of them reset with the
// month — so the whole delta set becomes month-to-date at the boundary.
const CUMULATIVE_KEYS = [
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

    // Month-rollover guard: if the baseline belongs to a different month than
    // today, the cumulative counters have reset, so a raw diff is a false
    // minus. Treat the baseline as zero → deltas become month-to-date.
    const monthChanged = !!(baseline && today && monthOf(today) !== monthOf(baseline));

    const deltas = baseline ? computeDeltas(today, baseline, monthChanged) : null;
    return jsonResponse({ today, baseline, deltas, deltasAreMonthToDate: monthChanged });

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

// When monthChanged, the baseline is treated as zero so each delta == today's
// month-to-date figure (never a cross-month negative).
function computeDeltas(today, baseline, monthChanged) {
  const d = {};
  for (const k of CUMULATIVE_KEYS) {
    const base = monthChanged ? 0 : baseline[k];
    d[k] = +(today[k] - base).toFixed(2);
  }
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
