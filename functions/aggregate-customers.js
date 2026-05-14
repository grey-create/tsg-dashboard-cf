/**
 * Cloudflare Pages Function: /aggregate-customers
 *
 * Nightly aggregator that recomputes each Customer's totals based on:
 *   - Frozen Legacy snapshots (from Clarity migration)
 *   - Live activity from ShopVOX Quotes / Sales Orders / Invoices
 *
 * Architecture:
 *   - Reads all Customers with a ShopVOX Company ID (or UUIDs in Aliases)
 *   - Reads all live invoices and sales orders (bulk, filtered to non-voided)
 *   - Reads a recent slice of live quotes (capped pages)
 *   - Groups live data by ShopVOX customer UUID in memory
 *   - Combines with Legacy snapshots, writes totals back
 *   - Recomputes Segment using threshold logic
 *   - First run also locks in Legacy snapshots from existing Lifetime values
 *
 * Subrequest budget: targets ~45-48 to fit free-tier Cloudflare Workers (50 cap)
 *
 * Auth: Cloudflare Access (same policy as the rest of the dashboard)
 *
 * Triggers:
 *   - Cron (daily): configured via wrangler.toml
 *   - Manual: /aggregate-customers
 *   - Dry run: /aggregate-customers?dry=1
 *   - Skip writes, debug only: /aggregate-customers?dry=1&verbose=1
 *
 * Known V1 limitation:
 *   The existing Orders 12m / Value Ordered 12m / etc. fields hold frozen
 *   Clarity-era snapshots. As months pass they become stale for legacy-only
 *   customers. V2 will compute trailing windows from Legacy Jobs rollups.
 */

const AIRTABLE_BASE = "appiOWhszaVriPxDw";
const T_CUSTOMERS = "tblaNnNncEOdH6RHB";
const T_QUOTES = "tblE8hdXSyvedJEKu";
const T_SALES_ORDERS = "tblYv3uaqQvRCw8ZK";
const T_INVOICES = "tblwh4IsxQGTdH7b8";

const FORMULA_CHUNK = 50;

// Read caps to stay within 50 subrequest budget.
// Live data volumes (ShopVOX live ~8 months at TSG):
//   - Invoices: ~400 total → 4 pages
//   - Sales Orders: ~600 total → 6 pages
//   - Quotes: ~5000 total → would exceed budget, so cap at recent slice
const MAX_INVOICE_PAGES = 6;
const MAX_SO_PAGES = 8;
const MAX_QUOTE_PAGES = 15;

// Segment thresholds (days)
const DAYS_NEW = 180;      // <6mo since first order
const DAYS_RECENT = 180;   // recent order = last 6mo
const DAYS_ACTIVE = 365;   // ordered in last 12mo
const DAYS_AT_RISK = 730;  // 12-24mo
const DAYS_LAPSED = 1095;  // 24-36mo

// Segment value thresholds (£, ex VAT)
const VAL_CHAMPION = 25000;

// UUID detector for parsing the Aliases field
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dry") === "1";
  const verbose = url.searchParams.get("verbose") === "1";

  if (!env.AIRTABLE_TOKEN) {
    return jsonResponse({ ok: false, error: "AIRTABLE_TOKEN not configured" }, 500);
  }

  try {
    const result = await run(env.AIRTABLE_TOKEN, { dryRun, verbose });
    return jsonResponse({ ok: true, dryRun, ...result });
  } catch (err) {
    return jsonResponse(
      { ok: false, error: err.message, stack: err.stack },
      500
    );
  }
}

async function run(token, { dryRun, verbose }) {
  const startedAt = new Date().toISOString();

  // 1. Read all customers with a ShopVOX Company ID or non-empty Aliases
  const customers = await loadActiveCustomers(token);
  // Build a UUID → customerRecordId index (one customer may have multiple UUIDs via Aliases)
  const customerByUuid = new Map();
  for (const c of customers) {
    const primaryId = c.fields["ShopVOX Company ID"];
    if (primaryId) customerByUuid.set(primaryId, c);
    const aliasIds = extractUuids(c.fields["Aliases"]);
    for (const aid of aliasIds) {
      if (!customerByUuid.has(aid)) customerByUuid.set(aid, c);
    }
  }

  // 2. Read live data in bulk
  const invoices = await loadAllLive(token, T_INVOICES, MAX_INVOICE_PAGES, [
    "Customer ID", "Invoice Date", "Total Ex VAT", "Is Voided",
  ]);
  const salesOrders = await loadAllLive(token, T_SALES_ORDERS, MAX_SO_PAGES, [
    "Customer ID", "Created At ShopVOX", "Is Voided",
  ]);
  const quotes = await loadAllLive(token, T_QUOTES, MAX_QUOTE_PAGES, [
    "Customer ID", "Created At ShopVOX", "Is Voided",
  ], { sort: [{ field: "Created At ShopVOX", direction: "desc" }] });

  // 3. Group live activity by ShopVOX customer UUID
  const liveByUuid = new Map();
  function bumpUuid(uuid) {
    if (!liveByUuid.has(uuid)) {
      liveByUuid.set(uuid, {
        invoiceCount: 0, invoiceValue: 0,
        invoiceCount12m: 0, invoiceValue12m: 0,
        invoiceCount24m: 0, invoiceValue24m: 0,
        invoiceCount36m: 0, invoiceValue36m: 0,
        lastInvoiced: null,
        lastConfirmed: null,
        quoteCount: 0,
        lastQuoted: null,
      });
    }
    return liveByUuid.get(uuid);
  }

  const now = new Date();
  const d12m = daysBefore(now, 365);
  const d24m = daysBefore(now, 730);
  const d36m = daysBefore(now, 1095);

  for (const inv of invoices) {
    if (inv.fields["Is Voided"]) continue;
    const uuid = inv.fields["Customer ID"];
    if (!uuid) continue;
    const value = Number(inv.fields["Total Ex VAT"]) || 0;
    const date = parseDate(inv.fields["Invoice Date"]);
    const agg = bumpUuid(uuid);
    agg.invoiceCount += 1;
    agg.invoiceValue += value;
    if (date) {
      if (date >= d12m) { agg.invoiceCount12m += 1; agg.invoiceValue12m += value; }
      if (date >= d24m) { agg.invoiceCount24m += 1; agg.invoiceValue24m += value; }
      if (date >= d36m) { agg.invoiceCount36m += 1; agg.invoiceValue36m += value; }
      if (!agg.lastInvoiced || date > agg.lastInvoiced) agg.lastInvoiced = date;
    }
  }

  for (const so of salesOrders) {
    if (so.fields["Is Voided"]) continue;
    const uuid = so.fields["Customer ID"];
    if (!uuid) continue;
    const date = parseDate(so.fields["Created At ShopVOX"]);
    const agg = bumpUuid(uuid);
    if (date && (!agg.lastConfirmed || date > agg.lastConfirmed)) agg.lastConfirmed = date;
  }

  for (const q of quotes) {
    if (q.fields["Is Voided"]) continue;
    const uuid = q.fields["Customer ID"];
    if (!uuid) continue;
    const date = parseDate(q.fields["Created At ShopVOX"]);
    const agg = bumpUuid(uuid);
    agg.quoteCount += 1;
    if (date && (!agg.lastQuoted || date > agg.lastQuoted)) agg.lastQuoted = date;
  }

  // 4. For each customer, combine legacy + live, compute final values
  const updates = [];
  let lockedInCount = 0;
  for (const c of customers) {
    const f = c.fields;

    // Gather all UUIDs this customer is associated with
    const uuids = new Set();
    if (f["ShopVOX Company ID"]) uuids.add(f["ShopVOX Company ID"]);
    for (const aid of extractUuids(f["Aliases"])) uuids.add(aid);

    // Sum live aggregates across all UUIDs
    const live = mergeLiveForUuids(liveByUuid, uuids);

    // Determine legacy snapshots: use Legacy fields if set, else fall back to existing visible
    // values (and write the Legacy fields in this same update — first-run lock-in).
    const legacyOrders = pickLegacy(f, "Legacy Orders", "Orders Lifetime");
    const legacyValue = pickLegacy(f, "Legacy Value Ordered", "Value Ordered Lifetime");
    const legacyQuotes = pickLegacy(f, "Legacy Quotes", "Quotes Lifetime");
    const legacyLastInvoiced = pickLegacy(f, "Legacy Last Invoiced", "Last Invoiced");
    const legacyLastQuoted = pickLegacy(f, "Legacy Last Quoted", "Last Quoted");

    const needsLockIn = (
      f["Legacy Orders"] == null ||
      f["Legacy Value Ordered"] == null ||
      f["Legacy Quotes"] == null
    );

    // Legacy trailing windows are FROZEN — kept as snapshots from migration.
    // V1 trade-off: they don't decay; live activity is added on top.
    const legacyOrders12m = Number(f["Orders 12m"]) || 0;
    const legacyValue12m = Number(f["Value Ordered 12m"]) || 0;
    const legacyOrders24m = Number(f["Orders 24m"]) || 0;
    const legacyValue24m = Number(f["Value Ordered 24m"]) || 0;
    const legacyOrders36m = Number(f["Orders 36m"]) || 0;
    const legacyValue36m = Number(f["Value Ordered 36m"]) || 0;

    // Compute final values
    const newOrdersLifetime = legacyOrders.value + live.invoiceCount;
    const newValueLifetime = round2(legacyValue.value + live.invoiceValue);
    const newQuotesLifetime = legacyQuotes.value + live.quoteCount;

    const newOrders12m = legacyOrders12m + live.invoiceCount12m;
    const newValue12m = round2(legacyValue12m + live.invoiceValue12m);
    const newOrders24m = legacyOrders24m + live.invoiceCount24m;
    const newValue24m = round2(legacyValue24m + live.invoiceValue24m);
    const newOrders36m = legacyOrders36m + live.invoiceCount36m;
    const newValue36m = round2(legacyValue36m + live.invoiceValue36m);

    const newLastInvoiced = maxDate(legacyLastInvoiced.value, live.lastInvoiced);
    const newLastConfirmed = maxDate(parseDate(f["Last Confirmed"]), live.lastConfirmed);
    const newLastQuoted = maxDate(legacyLastQuoted.value, live.lastQuoted);

    // Compute days-since for segment logic
    const daysSinceOrder = newLastInvoiced ? daysBetween(newLastInvoiced, now) : null;
    const daysSinceQuote = newLastQuoted ? daysBetween(newLastQuoted, now) : null;

    const newConversionRate = newQuotesLifetime > 0
      ? round1((newOrdersLifetime / newQuotesLifetime) * 100)
      : 0;

    const newSegment = computeSegment({
      valLifetime: newValueLifetime,
      ordLifetime: newOrdersLifetime,
      qtLifetime: newQuotesLifetime,
      convRate: newConversionRate,
      daysSinceOrder,
      daysSinceQuote,
      firstInvoiced: parseDate(f["First Invoiced"]),
      now,
    });

    // Build the update payload (only fields that changed)
    const fields = {};
    if (notEqual(f["Orders Lifetime"], newOrdersLifetime)) fields["Orders Lifetime"] = newOrdersLifetime;
    if (notEqual(f["Value Ordered Lifetime"], newValueLifetime)) fields["Value Ordered Lifetime"] = newValueLifetime;
    if (notEqual(f["Quotes Lifetime"], newQuotesLifetime)) fields["Quotes Lifetime"] = newQuotesLifetime;
    if (notEqual(f["Conversion Rate Lifetime"], newConversionRate)) fields["Conversion Rate Lifetime"] = newConversionRate;
    if (notEqual(f["Orders 12m"], newOrders12m)) fields["Orders 12m"] = newOrders12m;
    if (notEqual(f["Value Ordered 12m"], newValue12m)) fields["Value Ordered 12m"] = newValue12m;
    if (notEqual(f["Orders 24m"], newOrders24m)) fields["Orders 24m"] = newOrders24m;
    if (notEqual(f["Value Ordered 24m"], newValue24m)) fields["Value Ordered 24m"] = newValue24m;
    if (notEqual(f["Orders 36m"], newOrders36m)) fields["Orders 36m"] = newOrders36m;
    if (notEqual(f["Value Ordered 36m"], newValue36m)) fields["Value Ordered 36m"] = newValue36m;
    if (newLastInvoiced && notEqualDate(f["Last Invoiced"], newLastInvoiced)) fields["Last Invoiced"] = isoDate(newLastInvoiced);
    if (newLastConfirmed && notEqualDate(f["Last Confirmed"], newLastConfirmed)) fields["Last Confirmed"] = isoDate(newLastConfirmed);
    if (newLastQuoted && notEqualDate(f["Last Quoted"], newLastQuoted)) fields["Last Quoted"] = isoDate(newLastQuoted);
    if (newSegment && f["Segment"] !== newSegment) fields["Segment"] = newSegment;

    // Lock-in legacy fields if not set yet
    if (needsLockIn) {
      lockedInCount += 1;
      if (legacyOrders.source === "fallback") fields["Legacy Orders"] = legacyOrders.value;
      if (legacyValue.source === "fallback") fields["Legacy Value Ordered"] = legacyValue.value;
      if (legacyQuotes.source === "fallback") fields["Legacy Quotes"] = legacyQuotes.value;
      if (legacyLastInvoiced.source === "fallback" && legacyLastInvoiced.value) {
        fields["Legacy Last Invoiced"] = isoDate(legacyLastInvoiced.value);
      }
      if (legacyLastQuoted.source === "fallback" && legacyLastQuoted.value) {
        fields["Legacy Last Quoted"] = isoDate(legacyLastQuoted.value);
      }
    }

    if (Object.keys(fields).length > 0) {
      updates.push({ id: c.id, fields });
    }
  }

  // 5. Write updates in batches of 10
  let written = 0;
  if (!dryRun && updates.length > 0) {
    written = await patchRecords(token, T_CUSTOMERS, updates);
  }

  return {
    summary: {
      startedAt,
      customersConsidered: customers.length,
      shopvoxUuidsIndexed: customerByUuid.size,
      liveInvoicesScanned: invoices.length,
      liveSalesOrdersScanned: salesOrders.length,
      liveQuotesScanned: quotes.length,
      liveUuidsWithActivity: liveByUuid.size,
      customersToUpdate: updates.length,
      customersLockedIn: lockedInCount,
      airtableWrites: written,
    },
    sampleUpdates: verbose ? updates.slice(0, 5) : updates.slice(0, 2),
  };
}

// ───────────────────────────────────────────────────────────────
// Loaders
// ───────────────────────────────────────────────────────────────

async function loadActiveCustomers(token) {
  // V1: Only fetch customers with ShopVOX activity (ShopVOX Company ID set OR Aliases non-empty).
  // Legacy-only customers (5,037 of them) are excluded to stay within Cloudflare's 50-subreq
  // budget — fetching all 5,287 would require 53 paginated reads alone.
  //
  // Trade-off: legacy-only customers' Segments don't refresh as time passes. A customer who
  // was "Active" at migration will stay "Active" forever even when they should become "Lapsed".
  //
  // Fix paths (both later):
  //   1. Workers Paid plan ($5/mo) → 1000-subreq budget → can scan all customers
  //   2. Convert Segment to a formula field → self-updates daily for everyone, free
  return fetchAllWithFormula(
    token,
    T_CUSTOMERS,
    "OR(NOT({ShopVOX Company ID}=''), NOT({Aliases}=''))",
    [
      "Company",
      "Segment",
      "ShopVOX Company ID",
      "Aliases",
      "Orders Lifetime",
      "Value Ordered Lifetime",
      "Quotes Lifetime",
      "Conversion Rate Lifetime",
      "Orders 12m", "Value Ordered 12m",
      "Orders 24m", "Value Ordered 24m",
      "Orders 36m", "Value Ordered 36m",
      "First Invoiced",
      "Last Invoiced",
      "Last Confirmed",
      "Last Quoted",
      "Days Since Order",
      "Days Since Quote",
      "Legacy Orders",
      "Legacy Value Ordered",
      "Legacy Quotes",
      "Legacy Last Invoiced",
      "Legacy Last Quoted",
    ]
  );
}

async function loadAllLive(token, tableId, maxPages, fields, opts = {}) {
  const records = [];
  let offset;
  let pages = 0;
  do {
    const params = new URLSearchParams();
    for (const f of fields) params.append("fields[]", f);
    params.set("pageSize", "100");
    if (opts.sort) {
      opts.sort.forEach((s, i) => {
        params.append(`sort[${i}][field]`, s.field);
        params.append(`sort[${i}][direction]`, s.direction);
      });
    }
    if (offset) params.set("offset", offset);
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}?${params}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(
        `${tableId} fetch failed at page ${pages + 1}: ${res.status} ${await res.text()}`
      );
    }
    const data = await res.json();
    records.push(...data.records);
    pages++;
    offset = data.offset;
  } while (offset && pages < maxPages);
  return records;
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
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`${tableId} read failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    out.push(...data.records);
    offset = data.offset;
  } while (offset);
  return out;
}

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
      body: JSON.stringify({ records: batch, typecast: true }),
    });
    if (!res.ok) {
      throw new Error(`PATCH failed at batch ${i}: ${res.status} ${await res.text()}`);
    }
    written += batch.length;
  }
  return written;
}

// ───────────────────────────────────────────────────────────────
// Segment computation
// ───────────────────────────────────────────────────────────────

function computeSegment({ valLifetime, ordLifetime, qtLifetime, convRate, daysSinceOrder, daysSinceQuote, firstInvoiced, now }) {
  // Time-waster takes precedence: 10+ quotes, <5% conversion, low value
  if (qtLifetime >= 10 && convRate < 5 && valLifetime < 5000) {
    return "Time-waster";
  }

  if (ordLifetime > 0) {
    // Customer has ordered at least once
    const daysSinceFirst = firstInvoiced ? daysBetween(firstInvoiced, now) : null;

    // New: first ever order in last 180 days
    if (daysSinceFirst != null && daysSinceFirst <= DAYS_NEW) {
      return "New";
    }
    // Champion: recent order + significant lifetime value
    if (daysSinceOrder != null && daysSinceOrder <= DAYS_RECENT && valLifetime >= VAL_CHAMPION) {
      return "Champion";
    }
    // Loyal: ordered in last 12mo, >= 3 lifetime orders
    if (daysSinceOrder != null && daysSinceOrder <= DAYS_ACTIVE && ordLifetime >= 3) {
      return "Loyal";
    }
    // Active: ordered in last 12mo
    if (daysSinceOrder != null && daysSinceOrder <= DAYS_ACTIVE) {
      return "Active";
    }
    // At Risk: 12-24mo since order
    if (daysSinceOrder != null && daysSinceOrder <= DAYS_AT_RISK) {
      return "At Risk";
    }
    // Lapsed: 24-36mo since order
    if (daysSinceOrder != null && daysSinceOrder <= DAYS_LAPSED) {
      return "Lapsed";
    }
    // Lost: 36mo+
    if (daysSinceOrder != null) {
      return "Lost";
    }
  } else {
    // Never ordered
    if (daysSinceQuote != null && daysSinceQuote <= DAYS_ACTIVE) {
      return "Prospect";
    }
    if (qtLifetime > 0) {
      return "Quote-only / Lost";
    }
  }
  return null; // unknown state — leave segment unchanged
}

// ───────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────

function extractUuids(text) {
  if (!text) return [];
  const matches = String(text).match(UUID_RE);
  return matches ? matches.map((m) => m.toLowerCase()) : [];
}

function mergeLiveForUuids(liveByUuid, uuids) {
  const merged = {
    invoiceCount: 0, invoiceValue: 0,
    invoiceCount12m: 0, invoiceValue12m: 0,
    invoiceCount24m: 0, invoiceValue24m: 0,
    invoiceCount36m: 0, invoiceValue36m: 0,
    lastInvoiced: null,
    lastConfirmed: null,
    quoteCount: 0,
    lastQuoted: null,
  };
  for (const uuid of uuids) {
    const a = liveByUuid.get(uuid);
    if (!a) continue;
    merged.invoiceCount += a.invoiceCount;
    merged.invoiceValue += a.invoiceValue;
    merged.invoiceCount12m += a.invoiceCount12m;
    merged.invoiceValue12m += a.invoiceValue12m;
    merged.invoiceCount24m += a.invoiceCount24m;
    merged.invoiceValue24m += a.invoiceValue24m;
    merged.invoiceCount36m += a.invoiceCount36m;
    merged.invoiceValue36m += a.invoiceValue36m;
    merged.quoteCount += a.quoteCount;
    merged.lastInvoiced = maxDate(merged.lastInvoiced, a.lastInvoiced);
    merged.lastConfirmed = maxDate(merged.lastConfirmed, a.lastConfirmed);
    merged.lastQuoted = maxDate(merged.lastQuoted, a.lastQuoted);
  }
  return merged;
}

function pickLegacy(fields, legacyKey, fallbackKey) {
  const legacyVal = fields[legacyKey];
  if (legacyVal != null) {
    return { value: legacyKey.includes("Last") ? parseDate(legacyVal) : Number(legacyVal), source: "legacy" };
  }
  const fb = fields[fallbackKey];
  if (fb != null) {
    return { value: fallbackKey.includes("Last") || fallbackKey.includes("Invoiced") || fallbackKey.includes("Quoted") ? parseDate(fb) : Number(fb), source: "fallback" };
  }
  return { value: legacyKey.includes("Last") ? null : 0, source: "fallback" };
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function daysBefore(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

function daysBetween(a, b) {
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

function maxDate(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function notEqual(a, b) {
  if (a == null && b == null) return false;
  if (a == null || b == null) return true;
  return Math.abs(Number(a) - Number(b)) > 0.005;
}

function notEqualDate(a, b) {
  const da = parseDate(a);
  const db = b instanceof Date ? b : parseDate(b);
  if (!da && !db) return false;
  if (!da || !db) return true;
  return isoDate(da) !== isoDate(db);
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
