/**
 * Cloudflare Pages Function: /customers-data
 *
 * Returns customer data for the dashboard table.
 *
 * Behaviour:
 *   - Default: excludes "Lost" and "Quote-only / Lost" segments (~900 active customers).
 *     This keeps the response under the 50-subrequest Cloudflare cap.
 *   - ?include=all : includes Lost segments. CURRENTLY FAILS on free Cloudflare tier
 *     (~5,200 customers = 53 paginated reads, exceeds limit). Will work on Workers Paid.
 *
 * Returns: { ok, customers: [...], total }
 *
 * Auth: Cloudflare Access (same as other dashboard endpoints).
 */

const AIRTABLE_BASE = "appiOWhszaVriPxDw";
const T_CUSTOMERS = "tblaNnNncEOdH6RHB";

const FIELDS = [
  "Company",
  "Segment",
  "Flag",
  "ShopVOX Company ID",
  "Aliases",
  "Notes",
  // Lifetime
  "Orders Lifetime",
  "Value Ordered Lifetime",
  "Quotes Lifetime",
  "Conversion Rate Lifetime",
  // Trailing windows
  "Orders 12m", "Value Ordered 12m",
  "Orders 24m", "Value Ordered 24m",
  "Orders 36m", "Value Ordered 36m",
  // Dates
  "First Invoiced",
  "Last Invoiced",
  "Last Confirmed",
  "Last Quoted",
  "Days Since Order",
  "Days Since Quote",
];

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const includeAll = url.searchParams.get("include") === "all";

  if (!env.AIRTABLE_TOKEN) {
    return jsonResponse({ ok: false, error: "AIRTABLE_TOKEN not configured" }, 500);
  }

  const formula = includeAll
    ? null
    : "AND(NOT({Segment}='Lost'), NOT({Segment}='Quote-only / Lost'))";

  try {
    const records = await fetchAllWithFormula(env.AIRTABLE_TOKEN, T_CUSTOMERS, formula, FIELDS);
    const customers = records.map((r) => ({ id: r.id, ...r.fields }));
    return jsonResponse({ ok: true, customers, total: customers.length, includeAll });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

async function fetchAllWithFormula(token, tableId, formula, fields) {
  const out = [];
  let offset;
  do {
    const params = new URLSearchParams();
    for (const f of fields) params.append("fields[]", f);
    params.set("pageSize", "100");
    if (formula) params.set("filterByFormula", formula);
    if (offset) params.set("offset", offset);
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}?${params}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`${tableId} read failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    out.push(...data.records);
    offset = data.offset;
  } while (offset);
  return out;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, max-age=60",
    },
  });
}
