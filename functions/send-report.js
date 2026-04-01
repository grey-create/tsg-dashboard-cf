// Cloudflare Pages Function: /send-report
// Sends the generated commentary via Resend email API

export async function onRequestPost(context) {
  const { env } = context;
  const RESEND_API_KEY    = env.RESEND_API_KEY;
  const REPORT_FROM_EMAIL = env.REPORT_FROM_EMAIL || 'reports@thesigngroup.co.uk';
  const DASHBOARD_URL     = env.DASHBOARD_URL     || 'https://tsg-dashboard-cf.pages.dev/sales';

  if (!RESEND_API_KEY) {
    return new Response(JSON.stringify({ error: 'RESEND_API_KEY not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const body = await context.request.json();
    const { commentary, recipients, subject, monthCovered, brandSummary, salesSummary } = body;

    if (!commentary || !recipients || recipients.length === 0) {
      return new Response(JSON.stringify({ error: 'Missing commentary or recipients' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    const htmlBody = buildEmailHtml(commentary, monthCovered, brandSummary, salesSummary, DASHBOARD_URL);

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: REPORT_FROM_EMAIL,
        to: recipients,
        subject: subject || `TSG Sales Update: ${monthCovered}`,
        html: htmlBody
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return new Response(JSON.stringify({ error: `Email send failed: ${response.status}`, detail: errText }), {
        status: 502, headers: { 'Content-Type': 'application/json' }
      });
    }

    const result = await response.json();
    return new Response(JSON.stringify({
      success: true,
      emailId: result.id,
      sentTo: recipients,
      sentAt: new Date().toISOString()
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ─── HELPERS ────────────────────────────────────────────────────────────────

function f(n) {
  return '£' + Math.round(Number(n) || 0).toLocaleString('en-GB');
}

function calcOverall(d) {
  if (!d) return 0;
  return d.overall > 0 ? d.overall : ((d.tsg || 0) + (d.wll || 0) + (d.nv || 0) + (d.other || 0));
}

// ─── EMAIL BUILDER ───────────────────────────────────────────────────────────

function buildEmailHtml(commentary, monthCovered, brandSummary, salesSummary, dashboardUrl) {

  // ── 1. INVOICING SUMMARY TABLE ─────────────────────────────────────────────
  let summaryTable = '';
  if (brandSummary) {
    const overall       = calcOverall(brandSummary);
    const overallTarget = brandSummary.overallTarget || 0;

    const brands = [
      { label: 'TSG',   val: brandSummary.tsg || 0, target: brandSummary.tsgTarget || 0, accent: '#16a34a' },
      { label: 'WLL',   val: brandSummary.wll || 0, target: brandSummary.wllTarget || 0, accent: '#2563eb' },
      { label: 'NV',    val: brandSummary.nv  || 0, target: brandSummary.nvTarget  || 0, accent: '#dc2626' },
      { label: 'Total', val: overall,                target: overallTarget,               accent: '#000',   bold: true },
    ];

    const rows = brands.map(b => {
      const diff      = b.target ? b.val - b.target : null;
      const diffStr   = diff === null ? '—' : (diff >= 0 ? '+' : '−') + f(Math.abs(diff));
      const diffColor = diff === null ? '#999' : (diff >= 0 ? '#15803d' : '#b91c1c');
      const fw        = b.bold ? '700' : '500';
      const bg        = b.bold ? '#f5f5f5' : '#fff';
      return `
      <tr style="background:${bg};">
        <td style="padding:10px 14px; border-bottom:1px solid #eee; font-weight:${fw}; color:${b.accent}; font-size:13px;">${b.label}</td>
        <td style="padding:10px 14px; border-bottom:1px solid #eee; text-align:right; font-weight:${fw}; font-size:13px;">${f(b.val)}</td>
        <td style="padding:10px 14px; border-bottom:1px solid #eee; text-align:right; color:#888; font-size:13px;">${b.target ? f(b.target) : '—'}</td>
        <td style="padding:10px 14px; border-bottom:1px solid #eee; text-align:right; font-weight:700; color:${diffColor}; font-size:13px;">${diffStr}</td>
      </tr>`;
    }).join('');

    summaryTable = `
    <p style="margin:0 0 8px 0; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:1px; color:#888;">Invoiced Sales — ${monthCovered}</p>
    <table style="width:100%; border-collapse:collapse; margin-bottom:24px; border:1px solid #e5e5e5; border-radius:6px; overflow:hidden;">
      <thead>
        <tr style="background:#f0f0f0;">
          <th style="text-align:left;  padding:8px 14px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.8px; color:#555; border-bottom:2px solid #ddd;">Brand</th>
          <th style="text-align:right; padding:8px 14px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.8px; color:#555; border-bottom:2px solid #ddd;">Invoiced</th>
          <th style="text-align:right; padding:8px 14px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.8px; color:#555; border-bottom:2px solid #ddd;">Target</th>
          <th style="text-align:right; padding:8px 14px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.8px; color:#555; border-bottom:2px solid #ddd;">+/−</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  // ── 2. NEW ORDERS STATS BAR ────────────────────────────────────────────────
  let ordersBar = '';
  if (salesSummary && salesSummary.totalOrders > 0) {
    const conv = salesSummary.totalEnquiries > 0
      ? Math.round(salesSummary.totalOrders / salesSummary.totalEnquiries * 100)
      : 0;

    const stats = [
      { label: 'New Orders Value', value: f(salesSummary.totalNewSales) },
      { label: 'Orders Won',       value: salesSummary.totalOrders },
      { label: 'Enquiries',        value: salesSummary.totalEnquiries },
      { label: 'Conversion',       value: conv + '%' },
    ];

    const cells = stats.map((s, i) => {
      const border = i < stats.length - 1 ? 'border-right:1px solid #ddd;' : '';
      return `
      <td style="padding:12px 16px; ${border} text-align:center;">
        <div style="font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.8px; color:#777; margin-bottom:4px;">${s.label}</div>
        <div style="font-size:18px; font-weight:800; color:#111; letter-spacing:-0.3px;">${s.value}</div>
      </td>`;
    }).join('');

    ordersBar = `
    <p style="margin:0 0 8px 0; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:1px; color:#888;">New Sales Orders — ${monthCovered}</p>
    <table style="width:100%; border-collapse:collapse; margin-bottom:28px; border:1px solid #ddd; border-radius:6px; overflow:hidden; background:#f8f8f8;">
      <tr>${cells}</tr>
    </table>`;
  }

  // ── 3. COMMENTARY ──────────────────────────────────────────────────────────
  // Parse the plain-text commentary into HTML, turning ## headings into
  // styled section dividers and **bold** into <strong>.
  const commentaryHtml = commentary
    .split('\n\n')
    .map(block => block.trim())
    .filter(block => block.length > 0)
    .map(block => {
      if (block.startsWith('## ')) {
        const heading = block.replace(/^## /, '');
        return `
        <div style="margin:28px 0 12px 0; padding-bottom:7px; border-bottom:2px solid #111;">
          <span style="font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:1.2px; color:#111;">${heading}</span>
        </div>`;
      }
      // Handle single-line bold headings that aren't ## (e.g. **Section**)
      let p = block
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');
      return `<p style="margin:0 0 14px 0; font-size:14px; line-height:1.7; color:#222;">${p}</p>`;
    })
    .join('');

  // ── 4. DASHBOARD BUTTON ────────────────────────────────────────────────────
  const dashboardButton = `
    <div style="text-align:center; margin:28px 0 8px 0;">
      <a href="${dashboardUrl}"
         style="display:inline-block; background:#000; color:#fff; text-decoration:none;
                padding:13px 30px; border-radius:7px; font-size:13px; font-weight:700;
                letter-spacing:0.3px;">
        View Full Dashboard &rarr;
      </a>
    </div>`;

  // ── 5. ASSEMBLE ────────────────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TSG Sales Update — ${monthCovered}</title>
</head>
<body style="margin:0; padding:0; background:#efefef; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;">
  <div style="max-width:620px; margin:28px auto; padding:0 16px 40px;">

    <!-- Header -->
    <div style="background:#000; color:#fff; padding:22px 28px; border-radius:10px 10px 0 0;">
      <div style="font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:2px; color:#666; margin-bottom:8px;">The Sign Group &bull; Sales Report</div>
      <div style="font-size:22px; font-weight:800; letter-spacing:-0.4px; line-height:1.2;">TSG Sales Update</div>
      <div style="font-size:13px; color:#888; margin-top:5px;">${monthCovered || 'Monthly Report'}</div>
    </div>

    <!-- Body -->
    <div style="background:#fff; padding:28px 28px 24px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">

      ${summaryTable}
      ${ordersBar}
      ${commentaryHtml}

      <hr style="border:none; border-top:1px solid #e5e5e5; margin:28px 0 20px;">

      ${dashboardButton}

      <hr style="border:none; border-top:1px solid #e5e5e5; margin:20px 0 16px;">

      <p style="font-size:11px; color:#bbb; margin:0; text-align:center; line-height:1.6;">
        Generated from the
        <a href="${dashboardUrl}" style="color:#bbb; text-decoration:underline;">TSG Sales Dashboard</a>.
        AI-assisted summary based on live Airtable data.
      </p>

    </div>
  </div>
</body>
</html>`;
}
