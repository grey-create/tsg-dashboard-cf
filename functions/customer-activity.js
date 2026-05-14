/**
 * Cloudflare Pages Function: /customer-activity
 *
 * Returns drilldown data for a single customer:
 *   - Linked Legacy Jobs (sorted by date desc)
 *   - Recent live Quotes / Sales Orders / Invoices (most recent 20 each)
 *
 * Expects: ?customer_id=recXXXXXXXXXXXXXX
 *
 * Auth: Cloudflare Access.
 */

const AIRTABLE_BASE = "appiOWhszaVriPxDw";
const T_CUSTOMERS = "tblaNnNncEOdH6RHB";
const T_LEGACY_JOBS = "tbl1dUUAL99A3zXlZ";
const T_QUOTES = "tblE8hdXSyvedJEKu";
const T_SALES_ORDERS = "tblYv3uaqQvRCw8ZK";
const T_INVOICES = "tblwh4IsxQGTdH7b8";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const RECENT_LIMIT = 20;

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customer_id");

  if (!env.AIRTABLE_TOKEN) {
    return jsonResponse({ ok: false, error: "AIRTABLE_TOKEN not configured" }, 500);
  }
  if (!customerId || !/^rec[A-Za-z0-9]{14}$/.test(customerId)) {
    return jsonResponse({ ok: false, error: "missing or invalid customer_id" }, 400);
  }

  try {
    // 1. Fetch the customer record to get ShopVOX IDs and Legacy Jobs links
    const customer = await fetchRecord(env.AIRTABLE_TOKEN, T_CUSTOMERS, customerId);
    const shopvoxId = customer.fields["ShopVOX Company ID"];
    const aliasIds = extractUuids(customer.fields["Aliases"]);
    const allShopvoxIds = [shopvoxId, ...aliasIds].filter(Boolean);
    const legacyJobLinkIds = customer.fields["Legacy Jobs"] || [];

    // 2. Fetch linked Legacy Jobs (by Airtable record ID)
    const legacyJobs = legacyJobLinkIds.length > 0
      ? await fetchRecordsByIds(env.AIRTABLE_TOKEN, T_LEGACY_JOBS, legacyJobLinkIds, [
          "Reference", "Date", "Status", "Value", "Description", "Contact",
        ])
      : [];
    legacyJobs.sort((a, b) => {
      const da = parseDateSafe(a.fields.Date);
      const db = parseDateSafe(b.fields.Date);
      return db - da;
    });

    // 3. Fetch recent live activity (filtered by ShopVOX Customer ID)
    let invoices = [];
    let salesOrders = [];
    let quotes = [];
    if (allShopvoxIds.length > 0) {
      const customerIdFilter = "OR(" +
        allShopvoxIds.map((id) => `{Customer ID}='${id.replace(/'/g, "\\'")}'`).join(",") +
        ")";

      [invoices, salesOrders, quotes] = await Promise.all([
        fetchRecentByFormula(env.AIRTABLE_TOKEN, T_INVOICES, customerIdFilter, [
          "Invoice ID", "Invoice Number", "Invoice Date", "Total Ex VAT", "Status", "Is Voided",
        ], "Invoice Date"),
        fetchRecentByFormula(env.AIRTABLE_TOKEN, T_SALES_ORDERS, customerIdFilter, [
          "SO ID", "SO Number", "Created At ShopVOX", "Total Ex VAT", "Status", "Is Voided", "Invoiced",
        ], "Created At ShopVOX"),
        fetchRecentByFormula(env.AIRTABLE_TOKEN, T_QUOTES, customerIdFilter, [
          "Quote ID", "Quote Number", "Created At ShopVOX", "Total Ex VAT", "Status", "Is Voided",
        ], "Created At ShopVOX"),
      ]);
    }

    return jsonResponse({
      ok: true,
      customer: {
        id: customer.id,
        company: customer.fields.Company,
        shopvoxId,
        aliasIds,
      },
      legacyJobs: legacyJobs.map((r) => ({ id: r.id, ...r.fields })),
      invoices: invoices.map((r) => ({ id: r.id, ...r.fields })),
      salesOrders: salesOrders.map((r) => ({ id: r.id, ...r.fields })),
      quotes: quotes.map((r) => ({ id: r.id, ...r.fields })),
      legacyJobsTotal: legacyJobs.length,
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

// ───────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────

async function fetchRecord(token, tableId, recordId) {
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}/${recordId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    throw new Error(`Record fetch failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function fetchRecordsByIds(token, tableId, ids, fields) {
  // Airtable doesn't have a bulk fetch-by-id endpoint, but filterByFormula(OR(RECORD_ID()=...)) works
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const formula = "OR(" + chunk.map((id) => `RECORD_ID()='${id}'`).join(",") + ")";
    const records = await fetchAllWithFormula(token, tableId, formula, fields);
    out.push(...records);
  }
  return out;
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

async function fetchRecentByFormula(token, tableId, formula, fields, sortField) {
  // Fetch one page sorted desc by sortField — we only need the most recent records.
  const params = new URLSearchParams();
  for (const f of fields) params.append("fields[]", f);
  params.set("pageSize", String(RECENT_LIMIT));
  params.set("maxRecords", String(RECENT_LIMIT));
  params.set("filterByFormula", formula);
  params.append("sort[0][field]", sortField);
  params.append("sort[0][direction]", "desc");
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}?${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`${tableId} recent fetch failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.records || [];
}

function extractUuids(text) {
  if (!text) return [];
  const matches = String(text).match(UUID_RE);
  return matches ? matches.map((m) => m.toLowerCase()) : [];
}

function parseDateSafe(s) {
  if (!s) return 0;
  const d = new Date(s);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
