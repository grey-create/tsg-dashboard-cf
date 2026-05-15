/**
 * Cloudflare Pages Function: /ai-chat
 *
 * Proxies a user question to Claude (Anthropic API) with tool use enabled.
 * Tools allow Claude to query the TSG customer database directly.
 *
 * Single-turn: each request is independent. No conversation history (for V1).
 *
 * Expects POST body: { message: "..." }
 * Returns: { ok, response: "markdown text with optional ```chart blocks", toolCalls: [...] }
 *
 * Auth: Cloudflare Access.
 */

const AIRTABLE_BASE = "appiOWhszaVriPxDw";
const T_CUSTOMERS = "tblaNnNncEOdH6RHB";
const T_LEGACY_JOBS = "tbl1dUUAL99A3zXlZ";
const T_QUOTES = "tblE8hdXSyvedJEKu";
const T_SALES_ORDERS = "tblYv3uaqQvRCw8ZK";
const T_INVOICES = "tblwh4IsxQGTdH7b8";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 4000;
const MAX_ITERATIONS = 5;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// ─────────────────────────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT_BASE = `You are an analyst for The Sign Group (TSG), a UK signage manufacturer (Leeds). You help the sales team understand customer data.

# Data
- ~5,287 customer records spanning legacy Clarity data (2008–2026) and live ShopVOX data (2025+).
- All financial figures are GBP, ex-VAT.
- TSG's financial year runs December to November.
- Today's date will be reflected in the data; current date is in the conversation.

# Customer segments
- **Champion**: ordered in last 6mo, ≥£25k lifetime value
- **Loyal**: ordered in last 12mo, ≥3 orders lifetime
- **Active**: ordered in last 12mo, <3 orders lifetime
- **New**: first order in last 6mo
- **At Risk**: no order in last 12–24 months
- **Lapsed**: no order in last 24–36 months
- **Lost**: no order in 36+ months
- **Prospect**: quoted in last 12mo, never ordered
- **Quote-only / Lost**: quoted but never ordered, no recent quote
- **Time-waster**: ≥10 quotes lifetime, <5% conversion, low value

# Available fields on customers
- Company (string)
- Segment (one of the above)
- Flag (VIP, Watch, Don't chase, or null)
- Notes (free text)
- Orders Lifetime, Value Ordered Lifetime, Quotes Lifetime (numbers)
- Conversion Rate Lifetime (percentage 0-100)
- Orders 12m, Value Ordered 12m (last 365 days)
- Orders 24m, Value Ordered 24m (last 730 days)
- Orders 36m, Value Ordered 36m (last 1095 days)
- First Invoiced, Last Invoiced, Last Confirmed, Last Quoted (dates)
- Days Since Order, Days Since Quote (integers)

# Response style
- Direct and factual. No motivational language. No excessive caveats.
- Lead with the answer. Detail second.
- Lists of customers: render as markdown tables. Limit to 20 rows unless the user asks for more.
- Trends and comparisons: include a chart in a \`\`\`chart code block (Chart.js v4 format, see below).
- Monetary values: GBP with £ symbol. Round to whole pounds above £1,000. Use thousands separators.
- Dates: "5 May 2026" format.
- If data isn't available, say so plainly — don't fabricate.
- Use minimum tool calls necessary. For broad questions, one query_customers call is usually enough.

# Chart format
Output charts in a \`\`\`chart code block. The page renders them with Chart.js v4. Use this structure:

\`\`\`chart
{
  "type": "bar",
  "data": {
    "labels": ["A", "B", "C"],
    "datasets": [{
      "label": "Value (£)",
      "data": [100, 200, 300],
      "backgroundColor": "#22c55e"
    }]
  },
  "options": {
    "responsive": true,
    "scales": { "y": { "beginAtZero": true } }
  }
}
\`\`\`

Dark-mode-friendly colour palette:
- Primary green: #22c55e
- Blue: #3b82f6
- Orange: #f97316
- Red: #ef4444
- Purple: #a855f7
- Cyan: #06b6d4
- Gold: #fbbf24
- Pink: #ec4899

For axis labels and ticks on dark mode, set \`"options.scales.x.ticks.color": "#a3a3a3"\` and same for y. Set grid colour to \`"#262626"\`.

# Tools
You have three tools:
1. **query_customers** — filter/sort/limit the customer table. Use this for "who/which/show me" questions.
2. **get_customer_detail** — full info + activity for one customer. Use when zooming in.
3. **compute_monthly_metric** — monthly buckets for trend questions. Use when the answer is a time series.

# Follow-up questions
The user may ask follow-up questions that build on previous answers in the conversation. Treat the conversation as a thread — when they say "narrow that to last quarter" or "break it down by brand", refer back to the previous results without re-running tools unless necessary. Reuse the data you've already pulled when you can.

Only call tools when needed. Don't call query_customers just to confirm something obvious.`;

function getSystemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return SYSTEM_PROMPT_BASE + `\n\n# Current date\nToday is ${today}.`;
}

// ─────────────────────────────────────────────────────────────────
// Tool definitions
// ─────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "query_customers",
    description: "Query the customer table. Returns matching customer records. Supports filtering on segment, flag, dates, monetary values, etc. Use this to find customers matching criteria.",
    input_schema: {
      type: "object",
      properties: {
        filters: {
          type: "array",
          description: "Array of filter conditions, ANDed together. Each filter is { field, op, value }.",
          items: {
            type: "object",
            properties: {
              field: {
                type: "string",
                description: "Field name to filter on, e.g. 'Segment', 'Value Ordered 12m', 'Days Since Order', 'Flag', 'Company'",
              },
              op: {
                type: "string",
                enum: ["equals", "not_equals", "in", "not_in", "gte", "lte", "gt", "lt", "contains", "is_set", "is_not_set"],
                description: "Comparison operator. 'in' takes an array of values. 'is_set' / 'is_not_set' need no value.",
              },
              value: {
                description: "The value to compare against. Type depends on the field — string for text fields, number for numeric, array for 'in'.",
              },
            },
            required: ["field", "op"],
          },
        },
        sort_by: { type: "string", description: "Field name to sort by." },
        sort_dir: { type: "string", enum: ["asc", "desc"], description: "Sort direction. Defaults to desc." },
        limit: { type: "integer", description: "Max results to return. Default 50, max 500." },
        fields: {
          type: "array",
          items: { type: "string" },
          description: "Field names to include in the result. Defaults to a useful subset. Pass [] to get all.",
        },
      },
    },
  },
  {
    name: "get_customer_detail",
    description: "Fetch full info plus recent activity (legacy jobs, live quotes/SOs/invoices) for one customer. Use when zooming into a specific customer.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string", description: "Airtable record ID, starts with 'rec'." },
        include_legacy_jobs: { type: "boolean", description: "Include historical Clarity jobs. Default true." },
        include_live_activity: { type: "boolean", description: "Include live ShopVOX quotes/SOs/invoices. Default true." },
      },
      required: ["customer_id"],
    },
  },
  {
    name: "compute_monthly_metric",
    description: "Compute monthly buckets of a metric across customers. Use for trend / time-series questions. Combines legacy and live data automatically.",
    input_schema: {
      type: "object",
      properties: {
        metric: {
          type: "string",
          enum: ["invoiced_value", "invoiced_count", "quote_count", "conversion_rate"],
          description: "What to bucket: 'invoiced_value' (sum of invoice totals £), 'invoiced_count' (count of invoices), 'quote_count' (count of quotes), 'conversion_rate' (invoiced / quoted * 100).",
        },
        customer_ids: {
          type: "array",
          items: { type: "string" },
          description: "Optional: Airtable customer record IDs to filter to. Omit for all customers.",
        },
        months_back: {
          type: "integer",
          description: "How many months back from today to include. Default 12.",
        },
      },
      required: ["metric"],
    },
  },
];

// ─────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────
export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "POST only" }, 405);
  }
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ ok: false, error: "ANTHROPIC_API_KEY not configured" }, 500);
  }
  if (!env.AIRTABLE_TOKEN) {
    return jsonResponse({ ok: false, error: "AIRTABLE_TOKEN not configured" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400);
  }
  const userMessage = body.message;
  if (!userMessage || typeof userMessage !== "string") {
    return jsonResponse({ ok: false, error: "Missing 'message' field" }, 400);
  }

  // Optional conversation history for multi-turn / follow-ups.
  // Each entry: { role: "user" | "assistant", content: "string" }
  // Cap at 16 entries (8 turns) to keep token cost bounded.
  const HISTORY_CAP = 16;
  let history = [];
  if (Array.isArray(body.history)) {
    history = body.history
      .filter((m) => m && typeof m === "object" && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.length > 0)
      .slice(-HISTORY_CAP);
  }

  try {
    const result = await runConversation(userMessage, history, env);
    return jsonResponse({ ok: true, ...result });
  } catch (err) {
    console.error("AI chat error:", err);
    return jsonResponse({ ok: false, error: err.message, stack: err.stack }, 500);
  }
}

// ─────────────────────────────────────────────────────────────────
// Conversation loop
// ─────────────────────────────────────────────────────────────────
async function runConversation(userMessage, history, env) {
  const messages = [];
  // Prior conversation turns (if any)
  if (history && history.length > 0) {
    for (const m of history) {
      messages.push({ role: m.role, content: m.content });
    }
  }
  // Current user message
  messages.push({ role: "user", content: userMessage });

  const toolCallsLog = [];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await callAnthropic(messages, env);

    if (response.stop_reason === "tool_use") {
      // Append Claude's message (containing tool_use blocks)
      messages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter((c) => c.type === "tool_use");
      const toolResults = [];

      for (const tu of toolUses) {
        let result;
        let isError = false;
        try {
          result = await executeTool(tu.name, tu.input, env);
        } catch (err) {
          result = { error: err.message };
          isError = true;
        }
        toolCallsLog.push({
          name: tu.name,
          input: tu.input,
          ok: !isError,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(result),
          ...(isError ? { is_error: true } : {}),
        });
      }

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // end_turn or max_tokens — extract final text
    const text = response.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n\n");

    return {
      response: text,
      toolCalls: toolCallsLog,
      iterations: i + 1,
      stopReason: response.stop_reason,
    };
  }

  throw new Error(`Max iterations (${MAX_ITERATIONS}) reached without final response`);
}

async function callAnthropic(messages, env) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: getSystemPrompt(),
      tools: TOOLS,
      messages,
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// ─────────────────────────────────────────────────────────────────
// Tool dispatch
// ─────────────────────────────────────────────────────────────────
async function executeTool(name, input, env) {
  switch (name) {
    case "query_customers":
      return queryCustomers(input, env);
    case "get_customer_detail":
      return getCustomerDetail(input, env);
    case "compute_monthly_metric":
      return computeMonthlyMetric(input, env);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─────────────────────────────────────────────────────────────────
// Tool: query_customers
// ─────────────────────────────────────────────────────────────────
const DEFAULT_CUSTOMER_FIELDS = [
  "Company", "Segment", "Flag",
  "Orders Lifetime", "Value Ordered Lifetime", "Quotes Lifetime", "Conversion Rate Lifetime",
  "Orders 12m", "Value Ordered 12m",
  "Last Invoiced", "Last Quoted",
  "Days Since Order", "Days Since Quote",
];

async function queryCustomers(input, env) {
  const filters = input.filters || [];
  const sortBy = input.sort_by;
  const sortDir = input.sort_dir || "desc";
  const limit = Math.min(input.limit || 50, 500);
  const fields = (input.fields && input.fields.length > 0)
    ? input.fields
    : (Array.isArray(input.fields) ? null : DEFAULT_CUSTOMER_FIELDS); // [] means all fields

  // Build Airtable filterByFormula
  const formula = buildAirtableFormula(filters);

  // Fetch matching records
  const records = await fetchAllWithFormula(env.AIRTABLE_TOKEN, T_CUSTOMERS, formula, fields, { capPages: 20 });

  // Sort in memory (Airtable sort is also possible but in-memory is simpler & supports nulls properly)
  let results = records.map((r) => ({ id: r.id, ...r.fields }));
  if (sortBy) {
    const mult = sortDir === "asc" ? 1 : -1;
    results.sort((a, b) => {
      const av = a[sortBy], bv = b[sortBy];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string") return mult * av.localeCompare(bv);
      return mult * (av - bv);
    });
  }
  const total = results.length;
  results = results.slice(0, limit);

  return {
    customers: results,
    returned: results.length,
    total_matching: total,
    filters_applied: filters,
    sort: sortBy ? { field: sortBy, direction: sortDir } : null,
  };
}

function buildAirtableFormula(filters) {
  if (!filters || filters.length === 0) return null;
  const parts = filters.map(filterToFormula).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return `AND(${parts.join(",")})`;
}

function filterToFormula(f) {
  const field = `{${f.field}}`;
  const v = f.value;
  const escStr = (s) => `'${String(s).replace(/'/g, "\\'")}'`;
  switch (f.op) {
    case "equals":
      return typeof v === "number" ? `${field}=${v}` : `${field}=${escStr(v)}`;
    case "not_equals":
      return typeof v === "number" ? `NOT(${field}=${v})` : `NOT(${field}=${escStr(v)})`;
    case "in":
      if (!Array.isArray(v) || v.length === 0) return null;
      return "OR(" + v.map((x) => typeof x === "number" ? `${field}=${x}` : `${field}=${escStr(x)}`).join(",") + ")";
    case "not_in":
      if (!Array.isArray(v) || v.length === 0) return null;
      return "AND(" + v.map((x) => typeof x === "number" ? `NOT(${field}=${x})` : `NOT(${field}=${escStr(x)})`).join(",") + ")";
    case "gte": return `${field}>=${Number(v)}`;
    case "lte": return `${field}<=${Number(v)}`;
    case "gt":  return `${field}>${Number(v)}`;
    case "lt":  return `${field}<${Number(v)}`;
    case "contains":
      return `FIND(LOWER(${escStr(v)}), LOWER(${field}))>0`;
    case "is_set":
      return `NOT(${field}='')`;
    case "is_not_set":
      return `${field}=''`;
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Tool: get_customer_detail
// ─────────────────────────────────────────────────────────────────
async function getCustomerDetail(input, env) {
  const customerId = input.customer_id;
  if (!customerId || !/^rec[A-Za-z0-9]{14}$/.test(customerId)) {
    throw new Error("Invalid or missing customer_id");
  }
  const includeLegacy = input.include_legacy_jobs !== false;
  const includeLive = input.include_live_activity !== false;

  const customer = await fetchRecord(env.AIRTABLE_TOKEN, T_CUSTOMERS, customerId);
  const shopvoxId = customer.fields["ShopVOX Company ID"];
  const aliasIds = extractUuids(customer.fields["Aliases"]);
  const allShopvoxIds = [shopvoxId, ...aliasIds].filter(Boolean);

  const result = {
    customer: { id: customer.id, ...customer.fields },
  };

  if (includeLegacy) {
    const legacyJobLinkIds = customer.fields["Legacy Jobs"] || [];
    const legacyJobs = legacyJobLinkIds.length > 0
      ? await fetchRecordsByIds(env.AIRTABLE_TOKEN, T_LEGACY_JOBS, legacyJobLinkIds.slice(0, 200), [
          "Reference", "Date", "Status", "Value", "Description",
        ])
      : [];
    legacyJobs.sort((a, b) => new Date(b.fields.Date || 0) - new Date(a.fields.Date || 0));
    result.legacy_jobs = legacyJobs.map((r) => ({ id: r.id, ...r.fields }));
    result.legacy_jobs_total = legacyJobLinkIds.length;
  }

  if (includeLive && allShopvoxIds.length > 0) {
    const filter = "OR(" + allShopvoxIds.map((id) => `{Customer ID}='${id.replace(/'/g, "\\'")}'`).join(",") + ")";
    const [invoices, salesOrders, quotes] = await Promise.all([
      fetchAllWithFormula(env.AIRTABLE_TOKEN, T_INVOICES, filter, [
        "Invoice Number", "Invoice Date", "Total Ex VAT", "Status", "Is Voided",
      ], { capPages: 2 }),
      fetchAllWithFormula(env.AIRTABLE_TOKEN, T_SALES_ORDERS, filter, [
        "SO Number", "Created At ShopVOX", "Total Ex VAT", "Status", "Is Voided", "Invoiced",
      ], { capPages: 2 }),
      fetchAllWithFormula(env.AIRTABLE_TOKEN, T_QUOTES, filter, [
        "Quote Number", "Created At ShopVOX", "Total Ex VAT", "Status", "Is Voided",
      ], { capPages: 2 }),
    ]);
    result.invoices = invoices.map((r) => ({ id: r.id, ...r.fields })).slice(0, 30);
    result.sales_orders = salesOrders.map((r) => ({ id: r.id, ...r.fields })).slice(0, 30);
    result.quotes = quotes.map((r) => ({ id: r.id, ...r.fields })).slice(0, 30);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────
// Tool: compute_monthly_metric
// ─────────────────────────────────────────────────────────────────
async function computeMonthlyMetric(input, env) {
  const metric = input.metric;
  const monthsBack = input.months_back || 12;
  const customerIds = input.customer_ids || [];

  // Build date range
  const now = new Date();
  const startDate = new Date(now);
  startDate.setMonth(startDate.getMonth() - monthsBack);
  const startIso = startDate.toISOString().slice(0, 10);

  // Resolve customer ShopVOX IDs and Legacy Jobs IDs if customer filter provided
  let shopvoxIds = null;
  let legacyJobIds = null;
  if (customerIds.length > 0) {
    const customers = await fetchRecordsByIds(env.AIRTABLE_TOKEN, T_CUSTOMERS, customerIds, [
      "ShopVOX Company ID", "Aliases", "Legacy Jobs",
    ]);
    shopvoxIds = new Set();
    legacyJobIds = new Set();
    for (const c of customers) {
      if (c.fields["ShopVOX Company ID"]) shopvoxIds.add(c.fields["ShopVOX Company ID"]);
      for (const aid of extractUuids(c.fields["Aliases"])) shopvoxIds.add(aid);
      for (const jid of (c.fields["Legacy Jobs"] || [])) legacyJobIds.add(jid);
    }
  }

  // Initialise buckets — one per month in range
  const buckets = {};
  const monthKeys = [];
  for (let m = monthsBack - 1; m >= 0; m--) {
    const d = new Date(now);
    d.setMonth(d.getMonth() - m);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthKeys.push(key);
    buckets[key] = { invoiced_value: 0, invoiced_count: 0, quote_count: 0 };
  }

  // Fetch live invoices in date range
  const invoiceFilter = `IS_AFTER({Invoice Date}, '${startIso}')`;
  const invoices = await fetchAllWithFormula(env.AIRTABLE_TOKEN, T_INVOICES, invoiceFilter, [
    "Customer ID", "Invoice Date", "Total Ex VAT", "Is Voided",
  ], { capPages: 8 });
  for (const inv of invoices) {
    if (inv.fields["Is Voided"]) continue;
    const cid = inv.fields["Customer ID"];
    if (shopvoxIds && !shopvoxIds.has(cid)) continue;
    const date = inv.fields["Invoice Date"];
    if (!date) continue;
    const key = date.slice(0, 7);
    if (!buckets[key]) continue;
    buckets[key].invoiced_value += Number(inv.fields["Total Ex VAT"]) || 0;
    buckets[key].invoiced_count += 1;
  }

  // Fetch live quotes in date range
  const quoteFilter = `IS_AFTER({Created At ShopVOX}, '${startIso}')`;
  const quotes = await fetchAllWithFormula(env.AIRTABLE_TOKEN, T_QUOTES, quoteFilter, [
    "Customer ID", "Created At ShopVOX", "Is Voided",
  ], { capPages: 15 });
  for (const q of quotes) {
    if (q.fields["Is Voided"]) continue;
    const cid = q.fields["Customer ID"];
    if (shopvoxIds && !shopvoxIds.has(cid)) continue;
    const date = q.fields["Created At ShopVOX"];
    if (!date) continue;
    const key = date.slice(0, 7);
    if (!buckets[key]) continue;
    buckets[key].quote_count += 1;
  }

  // Fetch legacy jobs in date range — only if monthsBack covers pre-ShopVOX era (before ~late 2025)
  // ShopVOX went live mid-late 2025. If our window crosses before that, query Legacy Jobs.
  const earliestNeeded = startDate;
  const shopvoxLiveDate = new Date("2025-09-01"); // approximate
  if (earliestNeeded < shopvoxLiveDate) {
    const legacyFilter = `IS_AFTER({Date}, '${startIso}')`;
    const legacyJobs = await fetchAllWithFormula(env.AIRTABLE_TOKEN, T_LEGACY_JOBS, legacyFilter, [
      "Date", "Status", "Value",
    ], { capPages: 10 });
    for (const j of legacyJobs) {
      if (legacyJobIds && !legacyJobIds.has(j.id)) continue;
      const date = j.fields["Date"];
      if (!date) continue;
      const key = date.slice(0, 7);
      if (!buckets[key]) continue;
      const status = j.fields["Status"];
      const value = Number(j.fields["Value"]) || 0;
      if (status === "Invoiced") {
        buckets[key].invoiced_value += value;
        buckets[key].invoiced_count += 1;
      }
      // Legacy jobs (Quoted Formal / Confirmed / Invoiced / Delivered statuses) all originated as quotes
      buckets[key].quote_count += 1;
    }
  }

  // Format output based on requested metric
  const series = monthKeys.map((key) => {
    const b = buckets[key];
    let value;
    let supporting;
    switch (metric) {
      case "invoiced_value":
        value = Math.round(b.invoiced_value * 100) / 100;
        supporting = { count: b.invoiced_count };
        break;
      case "invoiced_count":
        value = b.invoiced_count;
        supporting = { value: Math.round(b.invoiced_value * 100) / 100 };
        break;
      case "quote_count":
        value = b.quote_count;
        supporting = {};
        break;
      case "conversion_rate":
        value = b.quote_count > 0 ? Math.round((b.invoiced_count / b.quote_count) * 1000) / 10 : 0;
        supporting = { invoiced: b.invoiced_count, quoted: b.quote_count };
        break;
    }
    return { period: key, value, ...supporting };
  });

  return {
    metric,
    months_back: monthsBack,
    customers_filtered: customerIds.length > 0,
    customers_count: customerIds.length || null,
    series,
  };
}

// ─────────────────────────────────────────────────────────────────
// Airtable helpers
// ─────────────────────────────────────────────────────────────────
async function fetchRecord(token, tableId, recordId) {
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${tableId}/${recordId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Record fetch ${recordId} failed: ${res.status}`);
  return res.json();
}

async function fetchRecordsByIds(token, tableId, ids, fields) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const formula = "OR(" + chunk.map((id) => `RECORD_ID()='${id}'`).join(",") + ")";
    const records = await fetchAllWithFormula(token, tableId, formula, fields, { capPages: 5 });
    out.push(...records);
  }
  return out;
}

async function fetchAllWithFormula(token, tableId, formula, fields, opts = {}) {
  const out = [];
  let offset;
  let pages = 0;
  const cap = opts.capPages || 50;
  do {
    const params = new URLSearchParams();
    if (fields && fields.length > 0) {
      for (const f of fields) params.append("fields[]", f);
    }
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
    pages++;
    offset = data.offset;
  } while (offset && pages < cap);
  return out;
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────
function extractUuids(text) {
  if (!text) return [];
  const matches = String(text).match(UUID_RE);
  return matches ? matches.map((m) => m.toLowerCase()) : [];
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
