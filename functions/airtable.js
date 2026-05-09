// Cloudflare Pages Function: /airtable
// Returns per-rep monthly performance data for the sales dashboard.
//
// Reads from new base appiOWhszaVriPxDw (TSG Dashboard — Live):
//   - Monthly Summary by Rep (tblJV3tOO5145K7Hu)
//
// Migrated from old base/table (appbx9KaWpz9q1qpE / tblgy7Oah36KTcmmS) in May 2026.
// Granularity changed from per-rep daily to per-rep monthly (sales.html aggregates
// to YYYY-MM internally so no consumer change is needed).
//
// Response shape: { records: [...], lastFetched: ISO string }
//   Each record: { date, employee, enq, orders, convRate, rejected, follow,
//                  valueEnq, valueOrd, aov, monthYear }

export async function onRequest(context) {
  const AIRTABLE_TOKEN = context.env.AIRTABLE_TOKEN;
  const BASE_ID  = "appiOWhszaVriPxDw";
  const TABLE_ID = "tblJV3tOO5145K7Hu";

  // Field IDs in Monthly Summary by Rep
  const F = {
    monthStart:     "fld9GRtl0yfIkbyY3",
    employee:       "fldtiueqbxIfZhVO6",  // singleSelect
    monthLabel:     "fldDRQyEYyYYUZ1nQ",
    enquiries:      "fldzMO8fCNTyxY6NT",
    orders:         "fld4lnBLps0ld1mYs",
    convRate:       "fldnfnuz5dK97ZrsI",  // percent (decimal 0–1)
    quotesRejected: "fldj8M0G0ImIprbEw",
    quotesPending:  "fldhPUjyen3uiBpiB",
    valueEnq:       "fld0pU4o4FGv5nX2y",
    valueOrd:       "fldLZLoNuNS6HhKQ7",
    aov:            "fldTWsx6SJxpoqPLP",
    lastAggregated: "fldhIlOJ0jQS5LtYx",
  };

  if (!AIRTABLE_TOKEN) {
    return new Response(JSON.stringify({ error: "AIRTABLE_TOKEN not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  const headers = {
    "Authorization": "Bearer " + AIRTABLE_TOKEN,
    "Content-Type": "application/json"
  };

  // singleSelect can return as either string or { id, name, color } depending on options.
  // This handles both safely.
  function selName(v) {
    if (!v) return "";
    if (typeof v === "string") return v;
    if (typeof v === "object" && v.name) return v.name;
    return "";
  }

  try {
    let allRecords = [];
    let offset = null;

    do {
      const url = new URL("https://api.airtable.com/v0/" + BASE_ID + "/" + TABLE_ID);
      url.searchParams.set("pageSize", "100");
      url.searchParams.set("returnFieldsByFieldId", "true");
      url.searchParams.set("sort[0][field]", F.monthStart);
      url.searchParams.set("sort[0][direction]", "asc");
      if (offset) url.searchParams.set("offset", offset);

      const res = await fetch(url.toString(), { headers });
      if (!res.ok) {
        const err = await res.text();
        return new Response(JSON.stringify({ error: "Airtable API error: " + err }), {
          status: res.status,
          headers: { "Content-Type": "application/json" }
        });
      }

      const data = await res.json();
      allRecords = allRecords.concat(data.records);
      offset = data.offset || null;
    } while (offset);

    // Find the most recent Last Aggregated timestamp
    let lastAgg = null;
    allRecords.forEach(r => {
      const t = r.fields[F.lastAggregated];
      if (t && (!lastAgg || t > lastAgg)) lastAgg = t;
    });

    const records = allRecords
      .filter(r => r.fields[F.employee] && r.fields[F.monthStart])
      .map(r => {
        const f = r.fields;
        return {
          date:      f[F.monthStart],
          employee:  selName(f[F.employee]),
          enq:       Number(f[F.enquiries]) || 0,
          orders:    Number(f[F.orders]) || 0,
          convRate:  Number(f[F.convRate]) || 0,
          rejected:  Number(f[F.quotesRejected]) || 0,
          follow:    Number(f[F.quotesPending]) || 0,
          valueEnq:  Number(f[F.valueEnq]) || 0,
          valueOrd:  Number(f[F.valueOrd]) || 0,
          aov:       Number(f[F.aov]) || 0,
          monthYear: f[F.monthLabel] || ""
        };
      });

    return new Response(JSON.stringify({
      records,
      lastFetched: lastAgg || new Date().toISOString(),
      count: records.length
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300"
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
