// Cloudflare Pages Function — fetches 3 Airtable tables for the Sales Dashboard
// Deploy to: functions/sales-data.js (serves at /sales-data)
// Requires AIRTABLE_TOKEN environment variable in Cloudflare Pages settings

export async function onRequest(context) {
  const TOKEN = context.env.AIRTABLE_TOKEN;
  const BASE = "appbx9KaWpz9q1qpE";

  const TABLES = {
    overview:    "tblf2Svz59N1TrLoI",
    invoiced:    "tblVJzj3b8InNfXGw",
    conversions: "tblLcaZPn5zhuPNpS",
  };

  if (!TOKEN) {
    return new Response(JSON.stringify({ error: "AIRTABLE_TOKEN not configured" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  const hdrs = { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" };

  async function fetchTable(tableId, sortField) {
    let all = [], offset = null;
    do {
      const url = new URL("https://api.airtable.com/v0/" + BASE + "/" + tableId);
      url.searchParams.set("pageSize", "100");
      if (sortField) { url.searchParams.set("sort[0][field]", sortField); url.searchParams.set("sort[0][direction]", "asc"); }
      if (offset) url.searchParams.set("offset", offset);
      const res = await fetch(url.toString(), { headers: hdrs });
      if (!res.ok) throw new Error("Airtable error (" + tableId + "): " + await res.text());
      const data = await res.json();
      all = all.concat(data.records);
      offset = data.offset || null;
    } while (offset);
    return all;
  }

  // Resilient field getter — tries exact names then partial case-insensitive match
  function gf(fields, ...names) {
    for (const name of names) {
      if (fields[name] !== undefined && fields[name] !== null) return fields[name];
    }
    const keys = Object.keys(fields);
    for (const name of names) {
      const lower = name.toLowerCase();
      const match = keys.find(k => k.toLowerCase().includes(lower));
      if (match && fields[match] !== undefined && fields[match] !== null) return fields[match];
    }
    return null;
  }

  try {
    const [overviewRaw, invoicedRaw, conversionsRaw] = await Promise.all([
      fetchTable(TABLES.overview, "Date Entered"),
      fetchTable(TABLES.invoiced, "Date Entered"),
      fetchTable(TABLES.conversions, "Date Entered"),
    ]);

    // Debug: collect field names from first record of each table
    const debugFields = {
      overview: overviewRaw.length > 0 ? Object.keys(overviewRaw[0].fields).sort() : [],
      invoiced: invoicedRaw.length > 0 ? Object.keys(invoicedRaw[0].fields).sort() : [],
      conversions: conversionsRaw.length > 0 ? Object.keys(conversionsRaw[0].fields).sort() : [],
    };

    // --- Monthly Overview ---
    const overview = overviewRaw.filter(r => r.fields["Month/Year"]).map(r => {
      const f = r.fields;
      return {
        monthYear: f["Month/Year"] || "",
        month: gf(f, "Month") || "",
        dateEntered: f["Date Entered"] || "",
        phase: gf(f, "Phase") || "",
        workingDaysTotal: gf(f, "Working Days Total") || 0,
        workingDaysCompleted: gf(f, "Working Days Completed") || 0,
        tsgTarget: gf(f, "TSG - Target", "TSG Target") || 0,
        wllTarget: gf(f, "WLL - Target", "WLL Target") || 0,
        nvTarget: gf(f, "NV - Target", "NV Target") || 0,
        tsgConfidence: gf(f, "TSG Confidence") || "",
        tsgConfidenceNote: gf(f, "TSG Confidence Note") || "",
        wllPaceNote: gf(f, "WLL Pace Note") || "",
        nvPaceNote: gf(f, "NV Pace Note") || "",
        weekFocus: gf(f, "Week Focus") || "",
        optionalFocus: gf(f, "Optional Focus") || "",
        tsgWipDue: gf(f, "TSG WIP Due This Month", "TSG WIP Due"),
        tsgWipUndated: gf(f, "TSG WIP Undated"),
        tsgWipNextMonth: gf(f, "TSG WIP Next Month"),
        tsgInvoicedToDate: gf(f, "TSG Invoiced to Date", "TSG Invoiced"),
        wllInvoicedToDate: gf(f, "WLL Invoiced to Date", "WLL Invoiced"),
        nvInvoicedToDate: gf(f, "NV Invoiced to Date", "NV Invoiced"),
      };
    });

    // --- Invoiced Sales by Month ---
    const invoiced = invoicedRaw.filter(r => r.fields["Date Entered"]).map(r => {
      const f = r.fields;
      return {
        dateEntered: f["Date Entered"] || "",
        monthYear: gf(f, "Month/Year") || "",
        month: gf(f, "Month") || "",
        overall: gf(f, "Overall Sales + VAT copy", "Overall Sales + VAT", "Overall Sales") || 0,
        tsg: gf(f, "TSG Sales + VAT", "TSG Sales") || 0,
        wll: gf(f, "WLL Sales + VAT", "WLL Sales") || 0,
        nv: gf(f, "NV Sales + VAT", "NV Sales") || 0,
        other: gf(f, "Other Sales + VAT", "Other Sales") || 0,
        overallTarget: gf(f, "Overall Invoice Target + VAT", "Overall Invoice Target") || 0,
        tsgTarget: gf(f, "TSG Invoice Target + VAT", "TSG Invoice Target") || 0,
        wllTarget: gf(f, "WLL Invoice Target + VAT", "WLL Invoice Target") || 0,
        nvTarget: gf(f, "NV Invoice Target + VAT", "NV Invoice Target") || 0,
        tsgNewSalesTarget: gf(f, "TSG NEW Sales Target + VAT", "TSG NEW Sales Target", "New Sales Target") || 0,
      };
    });

    // --- Conversions by Month ---
    const conversions = conversionsRaw.filter(r => r.fields["Date Entered"]).map(r => {
      const f = r.fields;
      return {
        dateEntered: f["Date Entered"] || "",
        monthYear: gf(f, "Month/Year") || "",
        month: gf(f, "Month") || "",
        enquiries: gf(f, "Enq's", "Enquiries", "Enqs") || 0,
        orders: gf(f, "Orders") || 0,
        convRate: gf(f, "% Conv. Rate", "Conv. Rate", "Conversion Rate", "Conv Rate") || 0,
        margin: gf(f, "% Margin", "Margin") || 0,
        aov: gf(f, "Ave Order Value", "Average Order Value", "AOV") || 0,
        salesConfirmed: gf(f, "Sales confirmed within", "Sales Confirmed", "Confirmed Sales", "New Sales Value") || 0,
        newSalesTarget: gf(f, "New Sales Target", "TSG NEW Sales Target") || 0,
      };
    });

    return new Response(JSON.stringify({ overview, invoiced, conversions, debugFields, lastFetched: new Date().toISOString() }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
}
