// Cloudflare Pages Function: /airtable-sales
// Fetches monthly brand sales data from Airtable (TSG, WLL, NV, Overall)

export async function onRequestGet(context) {
  const { env } = context;
  const token = env.AIRTABLE_TOKEN;
  const baseId = 'appbx9KaWpz9q1qpE';
  const tableId = 'tblVJzj3b8InNfXGw';
  const viewId = 'viwljacawJgGDcSmM';

  if (!token) {
    return new Response(JSON.stringify({ error: 'AIRTABLE_TOKEN not set' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    let allRecords = [];
    let offset = null;

    do {
      let url = `https://api.airtable.com/v0/${baseId}/${tableId}?view=${viewId}&pageSize=100`;
      if (offset) url += `&offset=${offset}`;

      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!res.ok) {
        const errText = await res.text();
        return new Response(JSON.stringify({ error: `Airtable error: ${res.status}`, detail: errText }), {
          status: 502, headers: { 'Content-Type': 'application/json' }
        });
      }

      const json = await res.json();
      allRecords = allRecords.concat(json.records || []);
      offset = json.offset || null;
    } while (offset);

    // Map Airtable field names to clean keys
    // Fields from Airtable: Date Entered, Overall Sales + VAT, TSG Sales + VAT,
    // WLL Sales + VAT, NV Sales + VAT, Other Sales + VAT,
    // Overall Invoice Target + VAT, TSG Invoice Target + VAT,
    // WLL Invoice Target + VAT, NV Invoice Target + VAT,
    // TSG NEW Sales Target + VAT, Month, Month/Year
    const records = allRecords
      .map(r => {
        const f = r.fields;
        return {
          date: f['Date Entered'] || null,
          month: f['Month'] || '',
          monthYear: f['Month/Year'] || '',
          overall: Number(f['Overall Sales + VAT']) || 0,
          tsg: Number(f['TSG Sales + VAT']) || 0,
          wll: Number(f['WLL Sales + VAT']) || 0,
          nv: Number(f['NV Sales + VAT']) || 0,
          other: Number(f['Other Sales + VAT']) || 0,
          overallTarget: Number(f['Overall Invoice Target + VAT']) || 0,
          tsgTarget: Number(f['TSG Invoice Target + VAT']) || 0,
          wllTarget: Number(f['WLL Invoice Target + VAT']) || 0,
          nvTarget: Number(f['NV Invoice Target + VAT']) || 0,
          tsgNewSalesTarget: Number(f['TSG NEW Sales Target + VAT']) || 0,
          // Additional fields from the second screenshot
          overallRank: f['Overall Rank'] || null,
          monthlyRank: f['Monthly Rank'] || null,
          turnover: Number(f['Turnover']) || 0,
          enquiries: Number(f['Enquiries']) || 0,
          conversionRate: f['Conversion Rate'] || null,
          ordersPlaced: Number(f['Orders Placed within the month']) || 0,
          growthFromPrevYr: f['Growth from Prev Yr'] || null
        };
      })
      .filter(r => r.date)
      .sort((a, b) => a.date.localeCompare(b.date));

    return new Response(JSON.stringify({
      records,
      lastFetched: new Date().toISOString(),
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
