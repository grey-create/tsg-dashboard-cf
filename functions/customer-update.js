/**
 * Cloudflare Pages Function: /customer-update
 *
 * Allows the dashboard to update a Customer record's Notes or Flag field.
 * Field allowlist prevents this endpoint from being used to write to anything else.
 *
 * Expects POST body: { recordId: "rec...", fields: { Notes: "...", Flag: "VIP" } }
 *
 * Auth: Cloudflare Access.
 */

const AIRTABLE_BASE = "appiOWhszaVriPxDw";
const T_CUSTOMERS = "tblaNnNncEOdH6RHB";
const ALLOWED_FIELDS = ["Notes", "Flag"];

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "POST only" }, 405);
  }
  if (!env.AIRTABLE_TOKEN) {
    return jsonResponse({ ok: false, error: "AIRTABLE_TOKEN not configured" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "invalid JSON body" }, 400);
  }

  const { recordId, fields } = body || {};
  if (!recordId || !/^rec[A-Za-z0-9]{14}$/.test(recordId)) {
    return jsonResponse({ ok: false, error: "missing or invalid recordId" }, 400);
  }
  if (!fields || typeof fields !== "object") {
    return jsonResponse({ ok: false, error: "missing fields object" }, 400);
  }

  // Allowlist: only Notes and Flag are writeable via this endpoint
  const safeFields = {};
  for (const k of Object.keys(fields)) {
    if (ALLOWED_FIELDS.includes(k)) {
      safeFields[k] = fields[k];
    }
  }
  if (Object.keys(safeFields).length === 0) {
    return jsonResponse({ ok: false, error: "no allowed fields to update" }, 400);
  }

  try {
    const res = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${T_CUSTOMERS}/${recordId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${env.AIRTABLE_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields: safeFields, typecast: true }),
      }
    );
    if (!res.ok) {
      throw new Error(`Airtable PATCH failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    return jsonResponse({ ok: true, id: data.id, fields: data.fields });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
