/**
 * Cloudflare Pages Function: /aggregate-customers
 *
 * Nightly aggregator. Recomputes each Customer's totals from:
 *   - Frozen Legacy snapshots (Clarity migration)
 *   - Live activity from ShopVOX Quotes / Sales Orders / Invoices
 *
 * Idempotent: re-running with no new live data produces no changes.
 *
 * Auth: Cloudflare Access
 * Triggers:
 *   - Cron daily via wrangler.toml
 *   - Manual: /aggregate-customers
 *   - Dry run: /aggregate-customers?dry=1
 *
 * V1 limitations:
 *   - Legacy trailing windows are frozen at migration date. Decay over time
 *     until V2 (rollup from Legacy Jobs) is built.
 *   - Quotes scan capped at 1500 most recent → Quotes Lifetime / Last Quoted
 *     for very rare customers may go stale.
 *   - Legacy-only customers are skipped → their Segment doesn't drift across
 *     Active → At Risk → Lapsed → Lost. Fix paths: Workers Paid, or convert
 *     Segment to a formula field.
 */

const AIRTABLE_BASE = "appiOWhszaVriPxDw";
const T_CUSTOMERS = "tblaNnNncEOdH6RHB";
const T_QUOTES = "tblE8hdXSyvedJEKu";
const T_SALES_ORDERS = "tblYv3uaqQvRCw8ZK";
const T_INVOICES = "tblwh4IsxQGTdH7b8";

const MAX_INVOICE_PAGES = 6;
const MAX_SO_PAGES = 8;
const MAX_QUOTE_PAGES = 15;

const DAYS_NEW = 180;
const DAYS_RECENT = 180;
const DAYS_ACTIVE = 365;
const DAYS_AT_RISK = 730;
const DAYS_LAPSED = 1095;

const VAL_CHAMPION = 25000;

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

  // 1. Load customers with ShopVOX activity
  const customers = await loadActiveCustomers(token);

  // 2. Read live data (bulk, filtered to non-voided in memory)
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
  const now = new Date();
  const d12m = daysBefore(now, 365);
  const d24m = daysBefore(now, 730);
  const d36m = daysBefore(now, 1095);
  const liveByUuid = groupLiveByUuid(invoices, salesOrders, quotes, { d12m, d24m, d36m });

  // 4. Compute updates per customer
  const updates = [];
  let lifetimeLockedIn = 0;
  let trailingLockedIn = 0;
  for (const c of customers) {
    const f = c.fields;

    // Aliases support: a single Customer may map to multiple ShopVOX UUIDs
    const uuids = new Set();
    if (f["ShopVOX Company ID"]) uuids.add(f["ShopVOX Company ID"]);
    for (const aid of extractUuids(f["Aliases"])) uuids.add(aid);
    const live = mergeLiveForUuids(liveByUuid, uuids);

    // Legacy lock-in: lifetime fields
    const needsLifetimeLockIn = (
      f["Legacy Orders"] == null ||
      f["Legacy Value Ordered"] == null ||
      f["Legacy Quotes"] == null
    );
    const legacyOrders = needsLifetimeLockIn
      ? Math.max(0, (Number(f["Orders Lifetime"]) || 0) - live.invoiceCount)
      : Number(f["Legacy Orders"]) || 0;
    const legacyValue = needsLifetimeLockIn
      ? Math.max(0, round2((Number(f["Value Ordered Lifetime"]) || 0) - live.invoiceValue))
      : Number(f["Legacy Value Ordered"]) || 0;
    const legacyQuotes = needsLifetimeLockIn
      ? Math.max(0, (Number(f["Quotes Lifetime"]) || 0) - live.quoteCount)
      : Number(f["Legacy Quotes"]) || 0;
    const legacyLastInvoiced = (f["Legacy Last Invoiced"] != null)
      ? parseDate(f["Legacy Last Invoiced"])
      : parseDate(f["Last Invoiced"]);
    const legacyLastQuoted = (f["Legacy Last Quoted"] != null)
      ? parseDate(f["Legacy Last Quoted"])
      : parseDate(f["Last Quoted"]);

    // Legacy lock-in: trailing window fields (the bug fix)
    const needsTrailingLockIn = (
      f["Legacy Orders 12m"] == null ||
      f["Legacy Value Ordered 12m"] == null
    );
    const legacyOrders12m = needsTrailingLockIn
      ? Math.max(0, (Number(f["Orders 12m"]) || 0) - live.invoiceCount12m)
      : Number(f["Legacy Orders 12m"]) || 0;
    const legacyValue12m = needsTrailingLockIn
      ? Math.max(0, round2((Number(f["Value Ordered 12m"]) || 0) - live.invoiceValue12m))
      : Number(f["Legacy Value Ordered 12m"]) || 0;
    const legacyOrders24m = needsTrailingLockIn
      ? Math.max(0, (Number(f["Orders 24m"]) || 0) - live.invoiceCount24m)
      : Number(f["Legacy Orders 24m"]) || 0;
    const legacyValue24m = needsTrailingLockIn
      ? Math.max(0, round2((Number(f["Value Ordered 24m"]) || 0) - live.invoiceValue24m))
      : Number(f["Legacy Value Ordered 24m"]) || 0;
    const legacyOrders36m = needsTrailingLockIn
      ? Math.max(0, (Number(f["Orders 36m"]) || 0) - live.invoiceCount36m)
      : Number(f["Legacy Orders 36m"]) || 0;
    const legacyValue36m = needsTrailingLockIn
      ? Math.max(0, round2((Number(f["Value Ordered 36m"]) || 0) - live.invoiceValue36m))
      : Number(f["Legacy Value Ordered 36m"]) || 0;

    // Final visible values: legacy + live
    const newOrdersLifetime = legacyOrders + live.invoiceCount;
    const newValueLifetime = round2(legacyValue + live.invoiceValue);
    const newQuotesLifetime = legacyQuotes + live.quoteCount;
    const newOrders12m = legacyOrders12m + live.invoiceCount12m;
    const newValue12m = round2(legacyValue12m + live.invoiceValue12m);
    const newOrders24m = legacyOrders24m + live.invoiceCount24m;
    const newValue24m = round2(legacyValue24m + live.invoiceValue24m);
    const newOrders36m = legacyOrders36m + live.invoiceCount36m;
    const newValue36m = round2(legacyValue36m + live.invoiceValue36m);

    const newLastInvoiced = maxDate(legacyLastInvoiced, live.lastInvoiced);
    const newLastConfirmed = maxDate(parseDate(f["Last Confirmed"]), live.lastConfirmed);
    const newLastQuoted = maxDate(legacyLastQuoted, live.lastQuoted);

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

    // Build delta payload (only fields that changed)
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

    // Lock-in lifetime legacy fields
    if (needsLifetimeLockIn) {
      lifetimeLockedIn += 1;
      if (f["Legacy Orders"] == null) fields["Legacy Orders"] = legacyOrders;
      if (f["Legacy Value Ordered"] == null) fields["Legacy Value Ordered"] = legacyValue;
      if (f["Legacy Quotes"] == null) fields["Legacy Quotes"] = legacyQuotes;
      if (f["Legacy Last Invoiced"] == null && legacyLastInvoiced) fields["Legacy Last Invoiced"] = isoDate(legacyLastInvoiced);
      if (f["Legacy Last Quoted"] == null && legacyLastQuoted) fields["Legacy Last Quoted"] = isoDate(legacyLastQuoted);
    }

    // Lock-in trailing window legacy fields
    if (needsTrailingLockIn) {
      trailingLockedIn += 1;
      if (f["Legacy Orders 12m"] == null) fields["Legacy Orders 12m"] = legacyOrders12m;
      if (f["Legacy Value Ordered 12m"] == null) fields["Legacy Value Ordered 12m"] = legacyValue12m;
      if (f["Legacy Orders 24m"] == null) fields["Legacy Orders 24m"] = legacyOrders24m;
      if (f["Legacy Value Ordered 24m"] == null) fields["Legacy Value Ordered 24m"] = legacyValue24m;
      if (f["Legacy Orders 36m"] == null) fields["Legacy Orders 36m"] = legacyOrders36m;
      if (f["Legacy Value Ordered 36m"] == null) fields["Legacy Value Ordered 36m"] = legacyValue36m;
    }

    if (Object.keys(fields).length > 0) {
      updates.push({ id: c.id, fields });
    }
  }

  // 5. Write
  let written = 0;
  if (!dryRun && updates.length > 0) {
    written = await patchRecords(token, T_CUSTOMERS, updates);
  }

  return {
    summary: {
      startedAt,
      customersConsidered: customers.length,
      liveInvoicesScanned: invoices.length,
      liveSalesOrdersScanned: salesOrders.length,
      liveQuotesScanned: quotes.length,
      liveUuidsWithActivity: liveByUuid.size,
      customersToUpdate: updates.length,
      lifetimeLockedIn,
      trailingLockedIn,
      airtableWrites: written,
    },
    sampleUpdates: verbose ? updates.slice(0, 5) : updates.slice(0, 2),
  };
}

// ───────────────────────────────────────────────────────────────
// Live data grouping
// ───────────────────────────────────────────────────────────────

function groupLiveByUuid(invoices, salesOrders, quotes, { d12m, d24m, d36m }) {
  const live = new Map();
  function bump(uuid) {
    if (!live.has(uuid)) {
      live.set(uuid, {
        invoiceCount: 0, invoiceValue: 0,
        invoiceCount12m: 0, invoiceValue12m: 0,
        invoiceCount24m: 0, invoiceValue24m: 0,
        invoiceCount36m: 0, invoiceValue36m: 0,
        lastInvoiced: null, lastConfirmed: null,
        quoteCount: 0, lastQuoted: null,
      });
    }
    return live.get(uuid);
  }

  for (const inv of invoices) {
    if (inv.fields["Is Voided"]) continue;
    const uuid = inv.fields["Customer ID"];
    if (!uuid) continue;
    const value = Number(inv.fields["Total Ex VAT"]) || 0;
    const date = parseDate(inv.fields["Invoice Date"]);
    const agg = bump(uuid);
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
    const agg = bump(uuid);
    if (date && (!agg.lastConfirmed || date > agg.lastConfirmed)) agg.lastConfirmed = date;
  }

  for (const q of quotes) {
    if (q.fields["Is Voided"]) continue;
    const uuid = q.fields["Customer ID"];
    if (!uuid) continue;
    const date = parseDate(q.fields["Created At ShopVOX"]);
    const agg = bump(uuid);
    agg.quoteCount += 1;
    if (date && (!agg.lastQuoted || date > agg.lastQuoted)) agg.lastQuoted = date;
  }
  return live;
}

function mergeLiveForUuids(live, uuids) {
  const merged = {
    invoiceCount: 0, invoiceValue: 0,
    invoiceCount12m: 0, invoiceValue12m: 0,
    invoiceCount24m: 0, invoiceValue24m: 0,
    invoiceCount36m: 0, invoiceValue36m: 0,
    lastInvoiced: null, lastConfirmed: null,
    quoteCount: 0, lastQuoted: null,
  };
  for (const uuid of uuids) {
    const a = live.get(uuid);
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

// ───────────────────────────────────────────────────────────────
// Airtable I/O
// ───────────────────────────────────────────────────────────────

async function loadActiveCustomers(token) {
  return fetchAllWithFormula(
    token,
    T_CUSTOMERS,
    "OR(NOT({ShopVOX Company ID}=''), NOT({Aliases}=''))",
    [
      "Company", "Segment",
      "ShopVOX Company ID", "Aliases",
      "Orders Lifetime", "Value Ordered Lifetime", "Quotes Lifetime", "Conversion Rate Lifetime",
      "Orders 12m", "Value Ordered 12m",
      "Orders 24m", "Value Ordered 24m",
      "Orders 36m", "Value Ordered 36m",
      "First Invoiced", "Last Invoiced", "Last Confirmed", "Last Quoted",
      "Days Since Order", "Days Since Quote",
      "Legacy Orders", "Legacy Value Ordered", "Legacy Quotes",
      "Legacy Last Invoiced", "Legacy Last Quoted",
      "Legacy Orders 12m", "Legacy Value Ordered 12m",
      "Legacy Orders 24m", "Legacy Value Ordered 24m",
      "Legacy Orders 36m", "Legacy Value Ordered 36m",
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
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`${tableId} fetch failed at page ${pages + 1}: ${res.status} ${await res.text()}`);
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
  if (qtLifetime >= 10 && convRate < 5 && valLifetime < 5000) {
    return "Time-waster";
  }

  if (ordLifetime > 0) {
    const daysSinceFirst = firstInvoiced ? daysBetween(firstInvoiced, now) : null;
    if (daysSinceFirst != null && daysSinceFirst <= DAYS_NEW) return "New";
    if (daysSinceOrder != null && daysSinceOrder <= DAYS_RECENT && valLifetime >= VAL_CHAMPION) return "Champion";
    if (daysSinceOrder != null && daysSinceOrder <= DAYS_ACTIVE && ordLifetime >= 3) return "Loyal";
    if (daysSinceOrder != null && daysSinceOrder <= DAYS_ACTIVE) return "Active";
    if (daysSinceOrder != null && daysSinceOrder <= DAYS_AT_RISK) return "At Risk";
    if (daysSinceOrder != null && daysSinceOrder <= DAYS_LAPSED) return "Lapsed";
    if (daysSinceOrder != null) return "Lost";
  } else {
    if (daysSinceQuote != null && daysSinceQuote <= DAYS_ACTIVE) return "Prospect";
    if (qtLifetime > 0) return "Quote-only / Lost";
  }
  return null;
}

// ───────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────

function extractUuids(text) {
  if (!text) return [];
  const matches = String(text).match(UUID_RE);
  return matches ? matches.map((m) => m.toLowerCase()) : [];
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

function round2(n) { return Math.round(n * 100) / 100; }
function round1(n) { return Math.round(n * 10) / 10; }

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
