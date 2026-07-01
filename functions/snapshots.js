// Cloudflare Pages Function: /snapshots
// Returns the last two Daily Snapshot rows (today + most recent previous day)
// so the dashboard can compute "+X today" deltas without each client doing
// its own arithmetic.
//
// MONTH-ROLLOVER FIX (2026-07-01, rev 2):
//   The chips show "what changed today" = today's snapshot minus yesterday's.
//   That works every day EXCEPT the 1st, when yesterday's row belongs to LAST
//   month. Two different kinds of figure behave differently across that
//   boundary, so we treat them differently:
//
//   FLOW figures (Invoiced, New Sales, Enquiries, Orders, WLL/NV invoiced,
//   the order counters) accumulate through a month and RESET to 0 on the 1st.
//   Their correct "today's change" on the 1st is measured from 0 — which on the
//   1st equals today's activity (the month is one day old). So baseline = 0.
//
//   STOCK figures (WIP Due This Month, and the TSG Total that contains it) are
//   a point-in-time balance that CARRIES OVER — on the 1st it's mostly work
//   ordered weeks ago, not anything that moved today. A 0 baseline would make
//   the chip claim the whole book changed today (e.g. "+£82,998"), which is
//   wrong. We don't hold yesterday's value for THIS month's WIP, so on the 1st
//   we peg the baseline to today's own value => the chip shows no movement
//   (±0) rather than a misleading number. From the 2nd onward it's the normal
//   day-over-day WIP change again.
//
//   The synthetic baseline is stamped with THIS month so nothing on the front
//   end reads it as a cross-month comparison. `deltasAreMonthToDate:false` is
//   returned so the chips render as the normal daily chips (no "this month"
//   label) — the numbers already ARE today's change. Self-limits to the 1st.

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

// Every numeric field a snapshot carries.
const NUM_KEYS = [
  "tsgInvoiced","tsgWipDue","tsgTotal","wllInvoiced","nvInvoiced",
  "newSalesVal","ordersPlaced","enquiries","quotesTotal",
  "ordersCreatedCumul","ordersCancelledCumul",
];

// STOCK fields = point-in-time balances that carry over the month boundary
// (not monthly tallies). On the 1st these must NOT be zero-based, or the chip
// shows the whole carried-over book as if it changed today. Everything else is
// a FLOW that genuinely resets to 0 at month start.
const STOCK_KEYS = ["tsgWipDue", "tsgTotal"];

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
    // today (i.e. it's the 1st), swap it for a start-of-month baseline stamped
    // with THIS month: flows start from 0 (so their delta = today's activity),
    // stocks are pegged to today's value (so their delta = 0, not the whole
    // carried-over book). Deltas then read as "today's change" for every chip.
    const monthChanged = !!(baseline && today && monthOf(today) !== monthOf(baseline));
    const effectiveBaseline = monthChanged ? startOfMonthBaseline(today) : baseline;

    const deltas = effectiveBaseline ? computeDeltas(today, effectiveBaseline) : null;
    // false on purpose: the numbers already ARE today's change, so the chips
    // should render as the normal daily chips (no "this month" label).
    return jsonResponse({
      today,
      baseline: effectiveBaseline,
      deltas,
      deltasAreMonthToDate: false,
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

// A start-of-month baseline stamped with today's month, dated the 1st.
// Flows start from 0 (they reset each month); stocks are pegged to today's own
// value so their delta is 0 (we don't hold the real start-of-day WIP for the
// new month, and the carried-over balance is not "today's change").
function startOfMonthBaseline(today) {
  const monthStart = today.monthStart || (today.date ? today.date.slice(0, 7) + "-01" : null);
  const b = {
    id:         null,
    date:       monthStart,   // 1st of the current month
    monthStart: monthStart,
    lastUpdated: null,
  };
  for (const k of NUM_KEYS) b[k] = STOCK_KEYS.includes(k) ? today[k] : 0;
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
