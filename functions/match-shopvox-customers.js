/**
 * Cloudflare Pages Function: /match-shopvox-customers
 *
 * One-shot matcher that populates the `ShopVOX Company ID` field on each
 * Customer record by reading the live Quotes/Sales Orders/Invoices tables.
 *
 * - Reads deduplicated {ShopVOX Customer ID, Customer Name} pairs from the 3 live tables
 * - Matches against Customers.Company using normalised name (trim + lowercase + collapse spaces)
 * - Existing matches: writes ShopVOX ID into the Customer row (won't overwrite an existing different ID)
 * - No-match: creates a new Customer record with Segment = "New" (Path A behaviour)
 * - Idempotent: second run is a no-op
 *
 * Returns JSON: { ok, summary: { ... }, conflicts: [...], created: [...] }
 *
 * Auth: Protected by Cloudflare Access (same policy as the rest of the dashboard).
 *
 * Trigger:
 *   - Manually in browser: https://tsg-dashboard-cf.pages.dev/match-shopvox-customers
 *   - With ?dry=1 to preview without writing anything
 */

const AIRTABLE_BASE = "appiOWhszaVriPxDw";
const T_CUSTOMERS = "tblaNnNncEOdH6RHB";
const T_QUOTES = "tblE8hdXSyvedJEKu";
const T_SALES_ORDERS = "tblYv3uaqQvRCw8ZK";
const T_INVOICES = "tblwh4IsxQGTdH7b8";

const FLD_CUSTOMER_ID_QUOTES = "Customer ID";
const FLD_CUSTOMER_NAME_QUOTES = "Customer Name";
// The live tables use identically named fields; we use the names directly.

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dry") === "1";

  if (!env.AIRTABLE_TOKEN) {
    return jsonResponse({ ok: false, error: "AIRTABLE_TOKEN not configured" }, 500);
  }

  try {
    const result = await runMatcher(env.AIRTABLE_TOKEN, dryRun);
    return jsonResponse({ ok: true, dryRun, ...result });
  } catch (err) {
    return jsonResponse(
      { ok: false, error: err.message, stack: err.stack },
      500
    );
  }
}

async function runMatcher(token, dryRun) {
  // 1. Load live tables, build deduplicated ShopVOX customer set
  const shopvoxCustomers = await loadShopvoxCustomers(token);
  console.log(`Found ${shopvoxCustomers.size} unique ShopVOX customers`);

  // 2. Load all Customers
  const customers = await loadCustomers(token);
  console.log(`Loaded ${customers.length} Customer records`);

  // 3. Build a name-keyed index of Customers for fast lookup
  const customerByKey = new Map();
  for (const c of customers) {
    const key = normaliseKey(c.fields.Company);
    if (key) customerByKey.set(key, c);
  }

  // 4. Match each ShopVOX pair
  const matched = []; // { customerId (Airtable rec), shopvoxId, name }
  const created = []; // { shopvoxId, name } — will get new Customer rows
  const conflicts = []; // { customer, existingId, attemptedId, name }
  const alreadyMatched = []; // already had correct ShopVOX ID, no action

  for (const [shopvoxId, name] of shopvoxCustomers.entries()) {
    const key = normaliseKey(name);
    const customer = customerByKey.get(key);

    if (customer) {
      const existingId = customer.fields["ShopVOX Company ID"];
      if (existingId && existingId !== shopvoxId) {
        conflicts.push({
          customer: customer.fields.Company,
          customerRecordId: customer.id,
          existingId,
          attemptedId: shopvoxId,
          name,
        });
      } else if (existingId === shopvoxId) {
        alreadyMatched.push({ customer: customer.fields.Company, shopvoxId });
      } else {
        matched.push({
          customerRecordId: customer.id,
          customer: customer.fields.Company,
          shopvoxId,
          name,
        });
      }
    } else {
      created.push({ shopvoxId, name });
    }
  }

  // 5. Write matched ShopVOX IDs into Customer rows
  let writes = 0;
  let creates = 0;
  if (!dryRun) {
    if (matched.length > 0) {
      writes = await patchCustomers(
        token,
        matched.map((m) => ({
          id: m.customerRecordId,
          fields: { "ShopVOX Company ID": m.shopvoxId },
        }))
      );
    }
    if (created.length > 0) {
      creates = await createCustomers(
        token,
        created.map((c) => ({
          fields: {
            Company: c.name,
            "ShopVOX Company ID": c.shopvoxId,
            Segment: "New",
          },
        }))
      );
    }
  }

  return {
    summary: {
      shopvoxCustomersFound: shopvoxCustomers.size,
      existingCustomers: customers.length,
      matched: matched.length,
      alreadyMatched: alreadyMatched.length,
      conflicts: conflicts.length,
      newCustomersCreated: created.length,
      airtableWrites: writes,
      airtableCreates: creates,
    },
    matched: matched.slice(0, 50), // sample
    conflicts, // always show all
    created: created.slice(0, 50), // sample
    alreadyMatched: alreadyMatched.slice(0, 10), // sample
  };
}

// ───────────────────────────────────────────────────────────────
// Airtable helpers
// ───────────────────────────────────────────────────────────────

async function loadShopvoxCustomers(token) {
  // Read all three live tables, build a Map: shopvoxCustomerId -> customerName.
  // De-duplicated by shopvoxId. If the same ID appears with different names across rows,
  // we keep the first one encountered.
  const seen = new Map();
  const sources = [
    { table: T_QUOTES, label: "Quotes" },
    { table: T_SALES_ORDERS, label: "Sales Orders" },
    { table: T_INVOICES, label: "Invoices" },
  ];

  for (const { table, label } of sources) {
    const records = await fetchAllRecords(token, table, [
      "Customer ID",
      "Customer Name",
    ]);
    for (const r of records) {
      const id = r.fields["Customer ID"];
      const name = r.fields["Customer Name"];
      if (id && name && !seen.has(id)) {
        seen.set(id, name);
      }
    }
    console.log(`  ${label}: ${records.length} rows scanned`);
  }
  return seen;
}

async function loadCustomers(token) {
  return fetchAllRecords(token, T_CUSTOMERS, [
    "Company",
    "ShopVOX Company ID",
  ]);
}

async function fetchAllRecords(token, tableId, fields) {
  const out = [];
  let offset;
  do {
    const params = new URLSearchParams();
    for (const f of fields) params.append("fields[]", f);
    params.set("pageSize", "100");
    if (offset) params.set("offset", offset);
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}?${params}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(
        `Airtable fetch ${tableId} failed: ${res.status} ${await res.text()}`
      );
    }
    const data = await res.json();
    out.push(...data.records);
    offset = data.offset;
  } while (offset);
  return out;
}

async function patchCustomers(token, updates) {
  // Airtable allows up to 10 records per PATCH (when using typecast/upsert),
  // but the standard limit is also 10 for the records.list update. We'll batch in 10s.
  let written = 0;
  for (let i = 0; i < updates.length; i += 10) {
    const batch = updates.slice(i, i + 10);
    const res = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${T_CUSTOMERS}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ records: batch }),
      }
    );
    if (!res.ok) {
      throw new Error(
        `Airtable PATCH failed at batch ${i}: ${res.status} ${await res.text()}`
      );
    }
    written += batch.length;
  }
  return written;
}

async function createCustomers(token, newRows) {
  let created = 0;
  for (let i = 0; i < newRows.length; i += 10) {
    const batch = newRows.slice(i, i + 10);
    const res = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${T_CUSTOMERS}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ records: batch, typecast: true }),
      }
    );
    if (!res.ok) {
      throw new Error(
        `Airtable POST failed at batch ${i}: ${res.status} ${await res.text()}`
      );
    }
    created += batch.length;
  }
  return created;
}

// ───────────────────────────────────────────────────────────────
// Name normalisation — same rule as the Clarity import
// ───────────────────────────────────────────────────────────────

function normaliseKey(name) {
  if (!name) return null;
  return String(name).trim().replace(/\s+/g, " ").toLowerCase();
}

// ───────────────────────────────────────────────────────────────
// Misc
// ───────────────────────────────────────────────────────────────

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
