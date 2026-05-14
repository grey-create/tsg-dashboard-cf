/**
 * Cloudflare Pages Function: /diag-airtable
 *
 * Diagnostic to figure out why writes to Customers are failing.
 * Walks through every layer:
 *   1. Confirms which token Cloudflare actually has (by prefix)
 *   2. Calls /v0/meta/whoami to verify token identity
 *   3. Lists bases the token can see
 *   4. Reads a single Customer record (proves read works on the table)
 *   5. Attempts a no-op PATCH on that record (writing "Notes" field to "")
 *
 * Returns: structured JSON with each step's success/failure and any error body.
 *
 * Auth: Protected by Cloudflare Access (same as the rest of the dashboard).
 */

const AIRTABLE_BASE = "appiOWhszaVriPxDw";
const T_CUSTOMERS = "tblaNnNncEOdH6RHB";

export async function onRequest(context) {
  const { env } = context;
  const results = {
    step1_envVar: null,
    step2_whoami: null,
    step3_basesAccessible: null,
    step4_readCustomer: null,
    step5_patchCustomer: null,
  };

  // Step 1: env var sanity check
  if (!env.AIRTABLE_TOKEN) {
    results.step1_envVar = { ok: false, error: "AIRTABLE_TOKEN env var is missing" };
    return jsonResponse({ ok: false, results });
  }
  const token = env.AIRTABLE_TOKEN.trim();
  results.step1_envVar = {
    ok: true,
    prefix: token.slice(0, 7),  // e.g. "patAB12" — enough to identify the token
    length: token.length,
    startsWithPat: token.startsWith("pat"),
    hasWhitespace: token !== env.AIRTABLE_TOKEN,
  };

  // Step 2: who is the token
  try {
    const r = await fetch("https://api.airtable.com/v0/meta/whoami", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await r.text();
    results.step2_whoami = {
      ok: r.ok,
      status: r.status,
      body: safeJson(body),
    };
  } catch (e) {
    results.step2_whoami = { ok: false, error: e.message };
  }

  // Step 3: list bases the token can access
  try {
    const r = await fetch("https://api.airtable.com/v0/meta/bases", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await r.text();
    const parsed = safeJson(body);
    results.step3_basesAccessible = {
      ok: r.ok,
      status: r.status,
      bases: parsed?.bases?.map((b) => ({
        id: b.id,
        name: b.name,
        permissionLevel: b.permissionLevel,  // 'read' / 'comment' / 'edit' / 'create'
      })),
      targetBaseFound: parsed?.bases?.some((b) => b.id === AIRTABLE_BASE),
    };
  } catch (e) {
    results.step3_basesAccessible = { ok: false, error: e.message };
  }

  // Step 4: read a single Customer record
  let testRecordId = null;
  try {
    const r = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${T_CUSTOMERS}?pageSize=1&fields[]=Company&fields[]=Notes`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const body = await r.text();
    const parsed = safeJson(body);
    testRecordId = parsed?.records?.[0]?.id;
    results.step4_readCustomer = {
      ok: r.ok,
      status: r.status,
      gotRecord: !!testRecordId,
      recordId: testRecordId,
      sample: parsed?.records?.[0]?.fields,
    };
  } catch (e) {
    results.step4_readCustomer = { ok: false, error: e.message };
  }

  // Step 5: attempt a no-op PATCH (write a single space to Notes, which is text and not the primary)
  if (testRecordId) {
    try {
      const r = await fetch(
        `https://api.airtable.com/v0/${AIRTABLE_BASE}/${T_CUSTOMERS}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            records: [
              { id: testRecordId, fields: { Notes: "diag-test" } },
            ],
          }),
        }
      );
      const body = await r.text();
      results.step5_patchCustomer = {
        ok: r.ok,
        status: r.status,
        body: safeJson(body),
      };
    } catch (e) {
      results.step5_patchCustomer = { ok: false, error: e.message };
    }
  } else {
    results.step5_patchCustomer = { skipped: "No record from step 4" };
  }

  return jsonResponse({ ok: true, results });
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return s; }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
