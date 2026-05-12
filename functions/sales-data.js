// Cloudflare Pages Function: /sales-data
// Returns three sections — overview, invoiced, conversions — used by review.html
// and insights.html (and read-only by some sections of sales.html).
//
// Reads from new base appiOWhszaVriPxDw (TSG Dashboard — Live):
//   - Monthly Summary (tblRc8zL5wLEgFdhv) -- drives `invoiced` and `conversions`
//   - Month Plan      (tbljzQ6pV1o8yOWw1) -- drives `overview` (with WIP/invoiced
//                                            from Monthly Summary merged in by month)
//
// WORKING DAYS — Fully auto-computed from real calendar dates and UK bank
// holidays. Two sources, in priority order:
//   1. Hardcoded list (HARDCODED_HOLIDAYS) — confirmed dates through 2028.
//      Always present, never stale, no network dependency.
//   2. Live gov.uk fetch — overrides the hardcoded list if reachable. Picks
//      up any future-year additions or rare changes (e.g. coronation
//      bank holidays) without code changes.
//
// The Month Plan table's Working Days Total / Completed fields were
// retired in May 2026 once auto-compute was proven. Those fields can be
// deleted from Airtable without affecting this endpoint.

// Hardcoded UK bank holidays (England & Wales division). Source: gov.uk,
// confirmed through end of 2028. Each year typically holds 8 bank holidays.
// Extend this list every couple of years (or let the live gov.uk fetch
// handle newer years automatically).
const HARDCODED_HOLIDAYS = new Set([
  // 2026
  "2026-01-01", // New Year's Day
  "2026-04-03", // Good Friday
  "2026-04-06", // Easter Monday
  "2026-05-04", // Early May bank holiday
  "2026-05-25", // Spring bank holiday
  "2026-08-31", // Summer bank holiday
  "2026-12-25", // Christmas Day
  "2026-12-28", // Boxing Day (substitute — 26 Dec falls on Saturday)
  // 2027
  "2027-01-01", // New Year's Day
  "2027-03-26", // Good Friday
  "2027-03-29", // Easter Monday
  "2027-05-03", // Early May bank holiday
  "2027-05-31", // Spring bank holiday
  "2027-08-30", // Summer bank holiday
  "2027-12-27", // Christmas Day (substitute — 25 Dec falls on Saturday)
  "2027-12-28", // Boxing Day (substitute — 26 Dec falls on Sunday)
  // 2028
  "2028-01-03", // New Year's Day (substitute — 1 Jan falls on Saturday)
  "2028-04-14", // Good Friday
  "2028-04-17", // Easter Monday
  "2028-05-01", // Early May bank holiday
  "2028-05-29", // Spring bank holiday
  "2028-08-28", // Summer bank holiday
  "2028-12-25", // Christmas Day
  "2028-12-26", // Boxing Day
]);

// In-memory cache for the live gov.uk fetch. Cloudflare Workers keep this
// hot across requests on the same isolate, so we fetch gov.uk's JSON ~once
// per isolate-lifetime rather than every page load.
let HOLIDAYS_CACHE = null;
let HOLIDAYS_FETCHED_AT = 0;
const HOLIDAYS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Build the active holiday set. Strategy: start from the hardcoded list,
// then layer the live gov.uk fetch on top if it succeeds. The hardcoded
// list guarantees this NEVER fails — even if gov.uk is down, every date
// through 2028 is covered.
async function getHolidays() {
  const now = Date.now();
  if (HOLIDAYS_CACHE && (now - HOLIDAYS_FETCHED_AT) < HOLIDAYS_TTL_MS) {
    return HOLIDAYS_CACHE;
  }
  const combined = new Set(HARDCODED_HOLIDAYS);
  try {
    const res = await fetch("https://www.gov.uk/bank-holidays.json", {
      cf: { cacheTtl: 86400, cacheEverything: true }, // edge-cache 24h too
    });
    if (res.ok) {
      const data = await res.json();
      const events = data["england-and-wales"]?.events || [];
      for (const e of events) combined.add(e.date); // dates are already "YYYY-MM-DD"
    }
  } catch (err) {
    console.warn(`gov.uk holiday fetch failed: ${err.message}. Using hardcoded list (${HARDCODED_HOLIDAYS.size} entries).`);
  }
  HOLIDAYS_CACHE = combined;
  HOLIDAYS_FETCHED_AT = now;
  return combined;
}

// Count working days in a month, optionally up to (and including) a given
// date. Returns count of weekdays (Mon-Fri) that are NOT bank holidays.
function countWorkingDays(monthStart, upToDate, holidays) {
  const [year, month] = monthStart.split("-").map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (upToDate && iso > upToDate) break;
    const dow = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
    if (dow === 0 || dow === 6) continue; // 0 = Sun, 6 = Sat
    if (holidays.has(iso)) continue;
    count++;
  }
  return count;
}

// Today's date in London time, as "YYYY-MM-DD". Working days "tick over" at
// midnight London (when the team's working day starts), not midnight UTC.
function todayLondon() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

export async function onRequest(context) {
  const TOKEN = context.env.AIRTABLE_TOKEN;
  const BASE  = "appiOWhszaVriPxDw";

  // Monthly Summary
  const MS_TABLE = "tblRc8zL5wLEgFdhv";
  const MS = {
    monthStart:      "fldhXWzihZZiv6Ey4",
    monthLabel:      "fld6OdopLG1uvww5r",
    tsgInvoiced:     "fldgGbb7ewq7Ja5sq",
    tsgNewSales:     "fldMobwpFaqt3a6tQ",
    tsgDatedWip:     "fldxkp8NdsJJogp8t",
    tsgDateTbcWip:   "fldawMfEfJYteXExp",
    tsgNmWip:        "fldCqORdC0NOpBmRh",
    tsgEnquiries:    "fldYmRps2Ahi7kjtc",
    tsgOrders:       "fldegXrbpiYOpDrfw",
    tsgConvRate:     "fldVz705DPc9pWwWz",
    tsgValueOrd:     "fldj3sYAKBvQrMMaS",
    wllInvoiced:     "fldyddtkZguhA3762",
    nvInvoiced:      "fldAncKiiLkjVm0UW",
    otherInvoiced:   "fld8iKdS7ZKiwM5N7",
    overallInvoiced: "fldoxUT9wPIsUV3BE",
    lastAggregated:  "fldamXlxJOZG6NQyP",
  };

  // Month Plan
  const MP_TABLE = "tbljzQ6pV1o8yOWw1";
  const MP = {
    monthStart:            "fldJkE6W7uCMNfnNA",
    monthLabel:            "fld4cRl8HeUwj09ZA",
    // workingDaysTotal / workingDaysCompleted fields removed May 2026 —
    // values are now auto-computed from real calendar + UK bank holidays.
    phase:                 "fldVGgkMJovmJEH5g",
    tsgInvoicedTarget:     "fld9OSyOijwLNIdDU",
    tsgNewSalesTarget:     "fld1ZohxvmjVHmV7G",
    wllInvoicedTarget:     "fldcqFo0hLWZlZngs",
    nvInvoicedTarget:      "fld5G2yfMmnuPZvkr",
    overallInvoicedTarget: "fldBgpz427D4QLsCo",
    tsgConfidence:         "fldCuBNTpQxHey6aG",  // singleSelect
    tsgConfidenceNote:     "fldgqDkObX0DmEMy1",
    wllPaceNote:           "flde5aCtNrh3oSxU6",
    nvPaceNote:            "fldtV3Ug5qtMmzkW3",
    weekFocus:             "fldbd8TRbIlrSZzLN",
    optionalFocus:         "fldvt1ut8UHdf40FU",
  };

  if (!TOKEN) {
    return new Response(JSON.stringify({ error: "AIRTABLE_TOKEN not configured" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  const hdrs = { Authorization: "Bearer " + TOKEN };

  async function fetchTable(tableId, sortFieldId) {
    let all = [], offset = null;
    do {
      const url = new URL("https://api.airtable.com/v0/" + BASE + "/" + tableId);
      url.searchParams.set("pageSize", "100");
      url.searchParams.set("returnFieldsByFieldId", "true");
      if (sortFieldId) {
        url.searchParams.set("sort[0][field]", sortFieldId);
        url.searchParams.set("sort[0][direction]", "asc");
      }
      if (offset) url.searchParams.set("offset", offset);
      const res = await fetch(url.toString(), { headers: hdrs });
      if (!res.ok) throw new Error("Airtable error (" + tableId + "): " + await res.text());
      const data = await res.json();
      all = all.concat(data.records);
      offset = data.offset || null;
    } while (offset);
    return all;
  }

  function selName(v) {
    if (!v) return "";
    if (typeof v === "string") return v;
    if (typeof v === "object" && v.name) return v.name;
    return "";
  }

  try {
    const [msRecords, mpRecords] = await Promise.all([
      fetchTable(MS_TABLE, MS.monthStart),
      fetchTable(MP_TABLE, MP.monthStart),
    ]);

    // Lookup: Monthly Summary fields by Month Start
    const msByMonth = {};
    msRecords.forEach(r => {
      const ms = r.fields[MS.monthStart];
      if (ms) msByMonth[ms] = r.fields;
    });

    // Lookup: Month Plan fields by Month Start
    const mpByMonth = {};
    mpRecords.forEach(r => {
      const ms = r.fields[MP.monthStart];
      if (ms) mpByMonth[ms] = r.fields;
    });

    // Auto-compute working days for every month in the overview using actual
    // calendar maths + UK bank holidays. The Airtable Working Days Total /
    // Completed fields remain (as advisory / manual-override fallback) but the
    // values we return are always the computed ones unless gov.uk is down.
    const holidays = await getHolidays();
    const todayStr = todayLondon();

    // ---- overview: Month Plan + to-date figures from Monthly Summary ----
    const overview = mpRecords
      .filter(r => r.fields[MP.monthStart])
      .map(r => {
        const f  = r.fields;
        const ms = f[MP.monthStart];
        const sf = msByMonth[ms] || {};

        // Working days: compute from real dates. For past months, "completed"
        // = total (the month is done). For the current month, "completed" =
        // working days up to and including today. For future months, "completed"
        // = 0. The maths handles all three cases via the upToDate parameter.
        const wdTotal = countWorkingDays(ms, null, holidays);
        // Is this month in the past, present, or future?
        const monthYM = ms.slice(0, 7);   // "YYYY-MM"
        const todayYM = todayStr.slice(0, 7);
        let wdCompleted;
        if (monthYM < todayYM)      wdCompleted = wdTotal;                              // past month
        else if (monthYM > todayYM) wdCompleted = 0;                                    // future month
        else                        wdCompleted = countWorkingDays(ms, todayStr, holidays); // current month

        // No Airtable fallback needed — the hardcoded HARDCODED_HOLIDAYS set
        // guarantees we always have a working list, even if gov.uk is down.
        // The Working Days Total / Completed fields can therefore be deleted
        // from the Month Plan table without affecting this endpoint.

        return {
          monthYear: f[MP.monthLabel] || "",
          month:     f[MP.monthLabel] || "",
          dateEntered: ms,
          phase: f[MP.phase] || "",
          workingDaysTotal:     wdTotal,
          workingDaysCompleted: wdCompleted,
          tsgTarget: Number(f[MP.tsgInvoicedTarget]) || 0,
          wllTarget: Number(f[MP.wllInvoicedTarget]) || 0,
          nvTarget:  Number(f[MP.nvInvoicedTarget])  || 0,
          tsgConfidence:     selName(f[MP.tsgConfidence]),
          tsgConfidenceNote: f[MP.tsgConfidenceNote] || "",
          wllPaceNote:       f[MP.wllPaceNote] || "",
          nvPaceNote:        f[MP.nvPaceNote] || "",
          weekFocus:         f[MP.weekFocus] || "",
          optionalFocus:     f[MP.optionalFocus] || "",
          // To-date / WIP figures merged from Monthly Summary for this month
          tsgWipDue:         Number(sf[MS.tsgDatedWip])   || 0,
          tsgWipUndated:     Number(sf[MS.tsgDateTbcWip]) || 0,
          tsgWipNextMonth:   Number(sf[MS.tsgNmWip])      || 0,
          tsgInvoicedToDate: Number(sf[MS.tsgInvoiced])   || 0,
          wllInvoicedToDate: Number(sf[MS.wllInvoiced])   || 0,
          nvInvoicedToDate:  Number(sf[MS.nvInvoiced])    || 0,
        };
      });

    // ---- invoiced: Monthly Summary mapped to legacy "Invoiced Sales" shape ----
    const invoiced = msRecords
      .filter(r => r.fields[MS.monthStart])
      .map(r => {
        const f  = r.fields;
        const ms = f[MS.monthStart];
        const mp = mpByMonth[ms] || {};

        const tsgInv  = Number(f[MS.tsgInvoiced])   || 0;
        const tsgDat  = Number(f[MS.tsgDatedWip])   || 0;
        const tsgTbc  = Number(f[MS.tsgDateTbcWip]) || 0;
        const tsgNm   = Number(f[MS.tsgNmWip])      || 0;

        return {
          dateEntered: ms,
          monthYear:   f[MS.monthLabel] || "",
          month:       f[MS.monthLabel] || "",
          overall: Number(f[MS.overallInvoiced]) || 0,
          tsg:     tsgInv + tsgDat + tsgTbc + tsgNm,
          wll:     Number(f[MS.wllInvoiced])   || 0,
          nv:      Number(f[MS.nvInvoiced])    || 0,
          other:   Number(f[MS.otherInvoiced]) || 0,
          overallTarget:     Number(mp[MP.overallInvoicedTarget]) || 0,
          tsgTarget:         Number(mp[MP.tsgInvoicedTarget])     || 0,
          wllTarget:         Number(mp[MP.wllInvoicedTarget])     || 0,
          nvTarget:          Number(mp[MP.nvInvoicedTarget])      || 0,
          tsgNewSalesTarget: Number(mp[MP.tsgNewSalesTarget])     || 0,
          tsgInvoiced:  tsgInv,
          tsgWip:       tsgDat,
          tsgUndated:   tsgTbc,
          tsgNextMonth: tsgNm,
        };
      });

    // ---- conversions: Monthly Summary mapped to legacy "Conversions by Mth" shape ----
    const conversions = msRecords
      .filter(r => r.fields[MS.monthStart])
      .map(r => {
        const f  = r.fields;
        const ms = f[MS.monthStart];
        const mp = mpByMonth[ms] || {};
        const valOrd = Number(f[MS.tsgValueOrd]) || 0;
        const orders = Number(f[MS.tsgOrders])   || 0;
        return {
          dateEntered: ms,
          monthYear:   f[MS.monthLabel] || "",
          month:       f[MS.monthLabel] || "",
          enquiries: Number(f[MS.tsgEnquiries]) || 0,
          orders,
          convRate:  f[MS.tsgConvRate] || 0,
          aov:       orders > 0 ? valOrd / orders : 0,
          salesConfirmed: Number(f[MS.tsgNewSales]) || 0,
          newSalesTarget: Number(mp[MP.tsgNewSalesTarget]) || 0,
        };
      });

    // lastFetched from latest Last Aggregated on Monthly Summary
    let lastAgg = null;
    msRecords.forEach(r => {
      const t = r.fields[MS.lastAggregated];
      if (t && (!lastAgg || t > lastAgg)) lastAgg = t;
    });

    return new Response(JSON.stringify({
      overview,
      invoiced,
      conversions,
      lastFetched: lastAgg || new Date().toISOString(),
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
        "Access-Control-Allow-Origin": "*"
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
}
