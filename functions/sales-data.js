// Cloudflare Pages Function — fetches 3 Airtable tables for the Sales Dashboard
// Deploy to: functions/sales-data.js (serves at /sales-data)
// Requires AIRTABLE_TOKEN environment variable in Cloudflare Pages settings

export async function onRequest(context) {
  const TOKEN = context.env.AIRTABLE_TOKEN;
  const BASE = "appbx9KaWpz9q1qpE";

  const TABLES = {
    overview:    "tblf2Svz59N1TrLoI",  // Monthly Overview
    invoiced:    "tblVJzj3b8InNfXGw",  // TSG: Invoiced Sales by Mth
    conversions: "tblLcaZPn5zhuPNpS",  // TSG: Conversions by Mth
  };

  if (!TOKEN) {
    return new Response(JSON.stringify({ error: "AIRTABLE_TOKEN not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const hdrs = {
    Authorization: "Bearer " + TOKEN,
    "Content-Type": "application/json",
  };

  // Fetch all records from a table (handles pagination)
  async function fetchTable(tableId, sortField, viewName) {
    let all = [];
    let offset = null;
    do {
      const url = new URL("https://api.airtable.com/v0/" + BASE + "/" + tableId);
      url.searchParams.set("pageSize", "100");
      if (sortField) {
        url.searchParams.set("sort[0][field]", sortField);
        url.searchParams.set("sort[0][direction]", "asc");
      }
      if (viewName) {
        url.searchParams.set("view", viewName);
      }
      if (offset) url.searchParams.set("offset", offset);

      const res = await fetch(url.toString(), { headers: hdrs });
      if (!res.ok) {
        const err = await res.text();
        throw new Error("Airtable error (" + tableId + "): " + err);
      }
      const data = await res.json();
      all = all.concat(data.records);
      offset = data.offset || null;
    } while (offset);
    return all;
  }

  try {
    // Fetch all 3 tables in parallel
    const [overviewRaw, invoicedRaw, conversionsRaw] = await Promise.all([
      fetchTable(TABLES.overview, "Date Entered"),
      fetchTable(TABLES.invoiced, "Date Entered"),
      fetchTable(TABLES.conversions, "Date Entered"),
    ]);

    // --- Map Monthly Overview ---
    const overview = overviewRaw
      .filter((r) => r.fields["Month/Year"])
      .map((r) => {
        const f = r.fields;
        return {
          monthYear: f["Month/Year"] || "",
          month: f["Month"] || "",
          dateEntered: f["Date Entered"] || "",
          phase: f["Phase"] || "",
          workingDaysTotal: f["Working Days Total"] || 0,
          workingDaysCompleted: f["Working Days Completed"] || 0,
          tsgTarget: f["TSG - Target"] || 0,
          wllTarget: f["WLL - Target"] || 0,
          nvTarget: f["NV - Target"] || 0,
          tsgConfidence: f["TSG Confidence"] || "",
          tsgConfidenceNote: f["TSG Confidence Note"] || "",
          wllPaceNote: f["WLL Pace Note"] || "",
          nvPaceNote: f["NV Pace Note"] || "",
          weekFocus: f["Week Focus"] || "",
          optionalFocus: f["Optional Focus"] || "",
          // WIP fields (may not exist yet — dashboard handles gracefully)
          tsgWipDue: f["TSG WIP Due This Month"] || null,
          tsgWipUndated: f["TSG WIP Undated"] || null,
          tsgWipNextMonth: f["TSG WIP Next Month"] || null,
          tsgInvoicedToDate: f["TSG Invoiced to Date"] || null,
          wllInvoicedToDate: f["WLL Invoiced to Date"] || null,
          nvInvoicedToDate: f["NV Invoiced to Date"] || null,
        };
      });

    // --- Map Invoiced Sales by Month ---
    const invoiced = invoicedRaw
      .filter((r) => r.fields["Date Entered"])
      .map((r) => {
        const f = r.fields;
        return {
          dateEntered: f["Date Entered"] || "",
          monthYear: f["Month/Year"] || "",
          month: f["Month"] || "",
          overall: f["Overall Sales + VAT copy"] || 0,
          tsg: f["TSG Sales + VAT"] || 0,
          wll: f["WLL Sales + VAT"] || 0,
          nv: f["NV Sales + VAT"] || 0,
          other: f["Other Sales + VAT"] || 0,
          overallTarget: f["Overall Invoice Target + VAT"] || 0,
          tsgTarget: f["TSG Invoice Target + VAT"] || 0,
          wllTarget: f["WLL Invoice Target + VAT"] || 0,
          nvTarget: f["NV Invoice Target + VAT"] || 0,
          tsgNewSalesTarget: f["TSG NEW Sales Target + VAT"] || 0,
        };
      });

    // --- Map Conversions by Month ---
    const conversions = conversionsRaw
      .filter((r) => r.fields["Date Entered"])
      .map((r) => {
        const f = r.fields;
        return {
          dateEntered: f["Date Entered"] || "",
          monthYear: f["Month/Year"] || "",
          month: f["Month"] || "",
          enquiries: f["Enq's"] || 0,
          orders: f["Orders"] || 0,
          convRate: f["% Conv. Rate"] || 0,
          margin: f["% Margin"] || 0,
          aov: f["Ave Order Value"] || 0,
          salesConfirmed: f["Sales confirmed within month"] || f["Sales confirmed within..."] || 0,
          newSalesTarget: f["New Sales Target"] || 0,
        };
      });

    return new Response(
      JSON.stringify({
        overview,
        invoiced,
        conversions,
        lastFetched: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
