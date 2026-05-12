// Cloudflare Pages Function: /snapshots
// Returns the last two Daily Snapshot rows (today + most recent previous day)
// so the dashboard can compute "+X today" deltas without each client doing
// its own arithmetic.
//
// Response shape:
//   {
//     today:     { date, tsgInvoiced, tsgWipDue, tsgTotal, wllInvoiced,
//                  nvInvoiced, newSalesVal, ordersPlaced, enquiries,
//                  quotesTotal, lastUpdated },
//     baseline:  { ...same fields, from the most recent day before today, or null },
//     deltas:    { tsgInvoiced, tsgWipDue, tsgTotal, wllInvoiced, nvInvoiced,
//                  newSalesVal, ordersPlaced, enquiries, quotesTotal }
//                  — all = today - baseline, or null when baseline unknown
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
};

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
      return jsonResponse({ today: null, baseline: null, deltas: null });
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

    const deltas = baseline ? computeDeltas(today, baseline) : null;
    return jsonResponse({ today, baseline, deltas });

  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

function mapRow(r) {
  const f = r.fields || {};
  return {
    id:            r.id,
    date:          f[F.snapshotDate]  || null,
    monthStart:    f[F.monthStart]    || null,
    tsgInvoiced:   num(f[F.tsgInvoiced]),
    tsgWipDue:     num(f[F.tsgWipDue]),
    tsgTotal:      num(f[F.tsgTotal]),
    wllInvoiced:   num(f[F.wllInvoiced]),
    nvInvoiced:    num(f[F.nvInvoiced]),
    newSalesVal:   num(f[F.newSalesVal]),
    ordersPlaced:  num(f[F.ordersPlaced]),
    enquiries:     num(f[F.enquiries]),
    quotesTotal:   num(f[F.quotesTotal]),
    lastUpdated:   f[F.lastUpdated]   || null,
  };
}

function computeDeltas(today, baseline) {
  const keys = ["tsgInvoiced","tsgWipDue","tsgTotal","wllInvoiced","nvInvoiced",
                "newSalesVal","ordersPlaced","enquiries","quotesTotal"];
  const d = {};
  for (const k of keys) d[k] = +(today[k] - baseline[k]).toFixed(2);
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
