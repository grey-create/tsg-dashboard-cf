// Cloudflare Pages Function: /airtable-sales
// Returns brand-level monthly figures (TSG, WLL, NV, Overall) plus targets.
//
// Reads from new base appiOWhszaVriPxDw (TSG Dashboard — Live):
//   - Monthly Summary (tblRc8zL5wLEgFdhv)  -- actuals
//   - Month Plan      (tbljzQ6pV1o8yOWw1)  -- targets
//
// Migrated from old base/table (appbx9KaWpz9q1qpE / tblVJzj3b8InNfXGw) in May 2026.
// Targets used to live alongside actuals in a single table; now they're split, so
// we fetch both and merge by Month Start before returning.
//
// Response shape: { records: [...], lastFetched, count }
//   Each record matches the legacy shape so consuming pages don't need changes.

export async function onRequestGet(context) {
  const { env } = context;
  const token = env.AIRTABLE_TOKEN;
  const BASE = "appiOWhszaVriPxDw";

  // Monthly Summary — actuals
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
    wllInvoiced:     "fldyddtkZguhA3762",
    nvInvoiced:      "fldAncKiiLkjVm0UW",
    otherInvoiced:   "fld8iKdS7ZKiwM5N7",
    overallInvoiced: "fldoxUT9wPIsUV3BE",
    lastAggregated:  "fldamXlxJOZG6NQyP",
  };

  // Month Plan — targets
  const MP_TABLE = "tbljzQ6pV1o8yOWw1";
  const MP = {
    monthStart:            "fldJkE6W7uCMNfnNA",
    tsgInvoicedTarget:     "fld9OSyOijwLNIdDU",
    tsgNewSalesTarget:     "fld1ZohxvmjVHmV7G",
    wllInvoicedTarget:     "fldcqFo0hLWZlZngs",
    nvInvoicedTarget:      "fld5G2yfMmnuPZvkr",
    overallInvoicedTarget: "fldBgpz427D4QLsCo",
  };

  if (!token) {
    return new Response(JSON.stringify({ error: 'AIRTABLE_TOKEN not set' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  async function fetchAll(tableId, sortFieldId) {
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

      const res = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) {
        throw new Error(`Airtable error (${tableId}) ${res.status}: ${await res.text()}`);
      }
      const data = await res.json();
      all = all.concat(data.records || []);
      offset = data.offset || null;
    } while (offset);
    return all;
  }

  try {
    const [msRecords, mpRecords] = await Promise.all([
      fetchAll(MS_TABLE, MS.monthStart),
      fetchAll(MP_TABLE, MP.monthStart),
    ]);

    // Build targets lookup keyed by Month Start (yyyy-mm-dd)
    const targetsByMonth = {};
    mpRecords.forEach(r => {
      const ms = r.fields[MP.monthStart];
      if (!ms) return;
      targetsByMonth[ms] = {
        overallTarget:     Number(r.fields[MP.overallInvoicedTarget]) || 0,
        tsgTarget:         Number(r.fields[MP.tsgInvoicedTarget]) || 0,
        wllTarget:         Number(r.fields[MP.wllInvoicedTarget]) || 0,
        nvTarget:          Number(r.fields[MP.nvInvoicedTarget]) || 0,
        tsgNewSalesTarget: Number(r.fields[MP.tsgNewSalesTarget]) || 0,
      };
    });

    // Map Monthly Summary records to legacy response shape
    const records = msRecords
      .filter(r => r.fields[MS.monthStart])
      .map(r => {
        const f = r.fields;
        const ms = f[MS.monthStart];
        const tgt = targetsByMonth[ms] || {
          overallTarget: 0, tsgTarget: 0, wllTarget: 0, nvTarget: 0, tsgNewSalesTarget: 0
        };

        // TSG total = invoiced + WIP buckets (matches legacy "TSG Sales" combined value)
        const tsgInvoiced   = Number(f[MS.tsgInvoiced])   || 0;
        const tsgDatedWip   = Number(f[MS.tsgDatedWip])   || 0;
        const tsgDateTbcWip = Number(f[MS.tsgDateTbcWip]) || 0;
        const tsgNmWip      = Number(f[MS.tsgNmWip])      || 0;
        const tsgTotal = tsgInvoiced + tsgDatedWip + tsgDateTbcWip + tsgNmWip;

        return {
          date:      ms,
          month:     f[MS.monthLabel] || '',
          monthYear: f[MS.monthLabel] || '',
          // Brand totals
          overall:      Number(f[MS.overallInvoiced]) || 0,
          tsg:          tsgTotal,
          tsgInvoiced:  tsgInvoiced,
          tsgWip:       tsgDatedWip,
          tsgUndated:   tsgDateTbcWip,
          tsgNextMonth: tsgNmWip,
          wll:          Number(f[MS.wllInvoiced])   || 0,
          nv:           Number(f[MS.nvInvoiced])    || 0,
          other:        Number(f[MS.otherInvoiced]) || 0,
          // Targets (from Month Plan)
          overallTarget:     tgt.overallTarget,
          tsgTarget:         tgt.tsgTarget,
          wllTarget:         tgt.wllTarget,
          nvTarget:          tgt.nvTarget,
          tsgNewSalesTarget: tgt.tsgNewSalesTarget,
          // TSG conversion / activity (was on the legacy Invoiced Sales table)
          enquiries:      Number(f[MS.tsgEnquiries]) || 0,
          conversionRate: f[MS.tsgConvRate] || null,
          ordersPlaced:   Number(f[MS.tsgOrders]) || 0,
          // New: TSG New Sales actual (not previously available on this endpoint)
          tsgNewSales:    Number(f[MS.tsgNewSales]) || 0,
        };
      });

    // lastFetched from latest Last Aggregated
    let lastAgg = null;
    msRecords.forEach(r => {
      const t = r.fields[MS.lastAggregated];
      if (t && (!lastAgg || t > lastAgg)) lastAgg = t;
    });

    return new Response(JSON.stringify({
      records,
      lastFetched: lastAgg || new Date().toISOString(),
      count: records.length
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'max-age=300'
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
