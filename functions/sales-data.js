// Cloudflare Pages Function: /sales-data
// Returns three sections — overview, invoiced, conversions — used by review.html
// and insights.html (and read-only by some sections of sales.html).
//
// Reads from new base appiOWhszaVriPxDw (TSG Dashboard — Live):
//   - Monthly Summary (tblRc8zL5wLEgFdhv) -- drives `invoiced` and `conversions`
//   - Month Plan      (tbljzQ6pV1o8yOWw1) -- drives `overview` (with WIP/invoiced
//                                            from Monthly Summary merged in by month)
//
// Migrated from old base (appbx9KaWpz9q1qpE) in May 2026 — was reading from three
// tables: Monthly Overview, Invoiced Sales by Mth, Conversions by Mth. The new
// architecture consolidates conversions + invoiced into Monthly Summary, and the
// previous Monthly Overview is replaced by Month Plan plus to-date figures merged
// from Monthly Summary.
//
// Response shape:
//   { overview: [...], invoiced: [...], conversions: [...], lastFetched }

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
    workingDaysTotal:      "fldtZMDuRbjYCxlcX",
    workingDaysCompleted:  "fldS6nOlt7ZZr9wWG",
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

    // ---- overview: Month Plan + to-date figures from Monthly Summary ----
    const overview = mpRecords
      .filter(r => r.fields[MP.monthStart])
      .map(r => {
        const f  = r.fields;
        const ms = f[MP.monthStart];
        const sf = msByMonth[ms] || {};
        return {
          monthYear: f[MP.monthLabel] || "",
          month:     f[MP.monthLabel] || "",
          dateEntered: ms,
          phase: f[MP.phase] || "",
          workingDaysTotal:     Number(f[MP.workingDaysTotal]) || 0,
          workingDaysCompleted: Number(f[MP.workingDaysCompleted]) || 0,
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
