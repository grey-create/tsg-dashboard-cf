/**
 * Cloudflare Pages Function: /match-shopvox-customers
 *
 * One-shot matcher that populates the `ShopVOX Company ID` field on each
 * Customer record by reading the live Quotes table (Quotes is the superset
 * of all ShopVOX customers since every job starts there).
 *
 * Designed to run within the 50-subrequest free-tier limit:
 *  - Scans Quotes only (not SO or Invoices), sorted recent-first
 *  - Caps pagination at MAX_QUOTE_PAGES, with early-exit when no new customers found
 *  - Fetches only relevant Customers via filterByFormula (chunked)
 *  - Idempotent: re-running produces no changes once everything is matched
 *
 * Returns JSON: { ok, summary, conflicts, matched (sample), created (sample) }
 *
 * Auth: Protected by Cloudflare Access (same policy as the rest of the dashboard).
 *
 * Triggers:
 *   - Dry run (preview only):  /match-shopvox-customers?dry=1
 *   - Full run:                /match-shopvox-customers
 *   - Increase scan depth:     /match-shopvox-customers?pages=50
 */

const AIRTABLE_BASE = "appiOWhszaVriPxDw";
const T_CUSTOMERS = "tblaNnNncEOdH6RHB";
const T_QUOTES = "tblE8hdXSyvedJEKu";

// Default scan depth. Each page = 100 records. With <100 customers and recent activity,
// typically resolved within 5-10 pages. Cap defends against runaway scans.
const DEFAULT_MAX_PAGES = 30;
// Stop scanning if this many consecutive pages add no new customer IDs.
const STAGNANT_PAGES_THRESHOLD = 5;
// Chunk size for filterByFormula OR() queries (URL length safety).
const FORMULA_CHUNK_SIZE = 50;

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dry") === "1";
  const maxPages = parseInt(url.searchParams.get("pages") || DEFAULT_MAX_PAGES, 10);

  if (!env.AIRTABLE_TOKEN) {
    return jsonResponse({ ok: false, error: "AIRTABLE_TOKEN not configured" }, 500);
  }

  try {
    const result = await runMatcher(env.AIRTABLE_TOKEN, { dryRun, maxPages });
    return jsonResponse({ ok: true, dryRun, ...result });
  } catch (err) {
    return jsonResponse(
      { ok: false, error: err.message, stack: err.stack },
      500
    );
  }
}

async function runMatcher(token, { dryRun, maxPages }) {
  // 1. Scan Quotes for unique ShopVOX customers (with early exit)
  const scanResult = await scanQuotesForCustomers(token, maxPages);
  const shopvoxCustomers = scanResult.customers;

  if (shopvoxCustomers.size === 0) {
    return {
      summary: { shopvoxCustomersFound: 0, ...scanResult.stats },
      note: "No ShopVOX customers found in Quotes table — has any data flowed in yet?",
    };
  }

  // 2. Load only the Customers that match (by name OR by existing ShopVOX ID)
  const shopvoxNames = Array.from(shopvoxCustomers.values());
  const shopvoxIds = Array.from(shopvoxCustomers.keys());

  const [byNameRecords, byIdRecords] = await Promise.all([
    fetchCustomersByNames(token, shopvoxNames),
    fetchCustomersByShopvoxIds(token, shopvoxIds),
  ]);

  // Merge and dedupe
  const relevantById = new Map();
  for (const r of [...byNameRecords, ...byIdRecords]) {
    relevantById.set(r.id, r);
  }
  const relevantCustomers = Array.from(relevantById.values());

  // 3. Build lookup indexes
  const customersByKey = new Map(); // normalised name -> customer
  const customersByShopvoxId = new Map();
  for (const c of relevantCustomers) {
    const key = normaliseKey(c.fields.Company);
    if (key) customersByKey.set(key, c);
    const sid = c.fields["ShopVOX Company ID"];
    if (sid) customersByShopvoxId.set(sid, c);
  }

  // 4. Match each ShopVOX customer
  const matched = [];        // ready to write ShopVOX ID
  const created = [];        // new Customer records to create
  const alreadyMatched = []; // already has correct ShopVOX ID
  const conflicts = [];      // existing ShopVOX ID on customer differs from incoming
  const nameMismatch = [];   // ID matches but name differs (informational, no action)

  for (const [shopvoxId, shopvoxName] of shopvoxCustomers.entries()) {
    // First check by ShopVOX ID (handles re-runs and name changes)
    const byId = customersByShopvoxId.get(shopvoxId);
    if (byId) {
      if (normaliseKey(byId.fields.Company) !== normaliseKey(shopvoxName)) {
        nameMismatch.push({
          customer: byId.fields.Company,
          shopvoxName,
          shopvoxId,
        });
      } else {
        alreadyMatched.push({ customer: byId.fields.Company, shopvoxId });
      }
      continue;
    }

    // Then check by name
    const byName = customersByKey.get(normaliseKey(shopvoxName));
    if (byName) {
      const existingId = byName.fields["ShopVOX Company ID"];
      if (existingId && existingId !== shopvoxId) {
        conflicts.push({
          customer: byName.fields.Company,
          customerRecordId: byName.id,
          existingId,
          attemptedId: shopvoxId,
          name: shopvoxName,
        });
      } else {
        matched.push({
          customerRecordId: byName.id,
          customer: byName.fields.Company,
          shopvoxId,
          name: shopvoxName,
        });
      }
      continue;
    }

    // No match — will create new Customer record
    created.push({ shopvoxId, name: shopvoxName });
  }

  // 5. Write
  let writes = 0;
  let creates = 0;
  if (!dryRun) {
    if (matched.length > 0) {
      writes = await patchRecords(
        token,
        T_CUSTOMERS,
        matched.map((m) => ({
          id: m.customerRecordId,
          fields: { "ShopVOX Company ID": m.shopvoxId },
        }))
      );
    }
    if (created.length > 0) {
      creates = await createRecords(
        token,
        T_CUSTOMERS,
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
      ...scanResult.stats,
      relevantCustomersLoaded: relevantCustomers.length,
      matched: matched.length,
      alreadyMatched: alreadyMatched.length,
      conflicts: conflicts.length,
      nameMismatches: nameMismatch.length,
      newCustomersCreated: created.length,
      airtableWrites: writes,
      airtableCreates: creates,
    },
    conflicts,     // always show all
    nameMismatch,  // always show all
    matched: matched.slice(0, 50),
    created: created.slice(0, 50),
    alreadyMatched: alreadyMatched.slice(0, 10),
  };
}

// ───────────────────────────────────────────────────────────────
// Quotes scan with early exit
// ───────────────────────────────────────────────────────────────

async function scanQuotesForCustomers(token, maxPages) {
  const customers = new Map(); // shopvoxId -> name
  let offset;
  let pages = 0;
  let stagnantPages = 0;
  let lastSeenCount = 0;

  do {
    const params = new URLSearchParams();
    params.append("fields[]", "Customer ID");
    params.append("fields[]", "Customer Name");
    params.set("pageSize", "100");
    params.append("sort[0][field]", "Created At ShopVOX");
    params.append("sort[0][direction]", "desc");
    if (offset) params.set("offset", offset);

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${T_QUOTES}?${params}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(
        `Quotes scan failed at page ${pages + 1}: ${res.status} ${await res.text()}`
      );
    }
    const data = await res.json();
    for (const r of data.records) {
      const id = r.fields["Customer ID"];
      const name = r.fields["Customer Name"];
      if (id && name && !customers.has(id)) customers.set(id, name);
    }
    pages++;

    if (customers.size === lastSeenCount) {
      stagnantPages++;
    } else {
      stagnantPages = 0;
      lastSeenCount = customers.size;
    }

    offset = data.offset;
    if (stagnantPages >= STAGNANT_PAGES_THRESHOLD) break;
  } while (offset && pages < maxPages);

  return {
    customers,
    stats: {
      quotesPagesScanned: pages,
      hitPageCap: pages >= maxPages && offset != null,
      earlyExitedOnStagnation: stagnantPages >= STAGNANT_PAGES_THRESHOLD,
    },
  };
}

// ───────────────────────────────────────────────────────────────
// Customer fetches via filterByFormula
// ───────────────────────────────────────────────────────────────

async function fetchCustomersByNames(token, names) {
  if (names.length === 0) return [];
  const all = [];
  for (let i = 0; i < names.length; i += FORMULA_CHUNK_SIZE) {
    const chunk = names.slice(i, i + FORMULA_CHUNK_SIZE);
    const conditions = chunk.map((n) => {
      const safe = String(n).replace(/'/g, "\\'");
      return `LOWER(TRIM({Company}))=LOWER('${safe}')`;
    });
    const formula = `OR(${conditions.join(",")})`;
    const records = await fetchByFormula(token, T_CUSTOMERS, formula, [
      "Company",
      "ShopVOX Company ID",
    ]);
    all.push(...records);
  }
  return all;
}

async function fetchCustomersByShopvoxIds(token, ids) {
  if (ids.length === 0) return [];
  const all = [];
  for (let i = 0; i < ids.length; i += FORMULA_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + FORMULA_CHUNK_SIZE);
    const conditions = chunk.map((id) => {
      const safe = String(id).replace(/'/g, "\\'");
      return `{ShopVOX Company ID}='${safe}'`;
    });
    const formula = `OR(${conditions.join(",")})`;
    const records = await fetchByFormula(token, T_CUSTOMERS, formula, [
      "Company",
      "ShopVOX Company ID",
    ]);
    all.push(...records);
  }
  return all;
}

async function fetchByFormula(token, tableId, formula, fields) {
  const out = [];
  let offset;
  do {
    const params = new URLSearchParams();
    for (const f of fields) params.append("fields[]", f);
    params.set("pageSize", "100");
    params.set("filterByFormula", formula);
    if (offset) params.set("offset", offset);
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}?${params}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(
        `Filter fetch on ${tableId} failed: ${res.status} ${await res.text()}`
      );
    }
    const data = await res.json();
    out.push(...data.records);
    offset = data.offset;
  } while (offset);
  return out;
}

// ───────────────────────────────────────────────────────────────
// Writes (PATCH / POST, batched at 10)
// ───────────────────────────────────────────────────────────────

async function patchRecords(token, tableId, updates) {
  let written = 0;
  for (let i = 0; i < updates.length; i += 10) {
    const batch = updates.slice(i, i + 10);
    const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ records: batch }),
    });
    if (!res.ok) {
      throw new Error(`PATCH failed at batch ${i}: ${res.status} ${await res.text()}`);
    }
    written += batch.length;
  }
  return written;
}

async function createRecords(token, tableId, newRows) {
  let created = 0;
  for (let i = 0; i < newRows.length; i += 10) {
    const batch = newRows.slice(i, i + 10);
    const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ records: batch, typecast: true }),
    });
    if (!res.ok) {
      throw new Error(`POST failed at batch ${i}: ${res.status} ${await res.text()}`);
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
