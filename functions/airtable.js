// Cloudflare Pages function — proxies Airtable API to keep the token private
export async function onRequest(context) {
  const AIRTABLE_TOKEN = context.env.AIRTABLE_TOKEN;
  const BASE_ID = "appbx9KaWpz9q1qpE";
  const TABLE_ID = "tblgy7Oah36KTcmmS";

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

  try {
    let allRecords = [];
    let offset = null;

    do {
      const url = new URL("https://api.airtable.com/v0/" + BASE_ID + "/" + TABLE_ID);
      url.searchParams.set("pageSize", "100");
      url.searchParams.set("view", "Dashboard Feed");
      url.searchParams.set("sort[0][field]", "Date");
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

    const records = allRecords
      .filter(r => r.fields["Employee"] && r.fields["Date"])
      .map(r => {
        const f = r.fields;
        return {
          date: f["Date"],
          employee: f["Employee"],
          enq: f["Enq's"] || 0,
          orders: f["Orders"] || 0,
          convRate: f["Conv. Rate"] || 0,
          rejected: f["Quotes Rejected"] || 0,
          follow: f["Quotes to follow"] || 0,
          valueEnq: f["Value Enq's"] || 0,
          valueOrd: f["Value Ord's"] || 0,
          ordCost: f["Ord Cost"] || 0,
          gp: f["Order GP"] || 0,
          margin: f["Profit Margin"] || 0,
          aov: f["Ave Ord Value"] || 0,
          monthYear: f["Month/Year"] || ""
        };
      });

    return new Response(JSON.stringify({ records, lastFetched: new Date().toISOString() }), {
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
