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
    const { commentary, recipients, subject, monthCovered, periodPosition, brandSummary, salesSummary } = body;

    if (!commentary || !recipients || recipients.length === 0) {
      return new Response(JSON.stringify({ error: 'Missing commentary or recipients' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    const htmlBody = buildEmailHtml(commentary, monthCovered, brandSummary, salesSummary, DASHBOARD_URL, periodPosition);

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

// Map periodPosition (week-1..4, eom) to human label for the subtitle.
function periodLabel(periodPosition) {
  const map = {
    'week-1': 'Week 1',
    'week-2': 'Week 2',
    'week-3': 'Week 3',
    'week-4': 'Week 4',
    'eom': 'Final',
    // Legacy values kept for backwards-compat if any cached client sends them.
    'start': 'Early',
    'mid': 'Mid-Month',
    'final-week': 'Final Week',
  };
  return map[periodPosition] || '';
}

// ─── EMAIL BUILDER ───────────────────────────────────────────────────────────

function buildEmailHtml(commentary, monthCovered, brandSummary, salesSummary, dashboardUrl, periodPosition) {

  // Derive the site origin cleanly regardless of what DASHBOARD_URL is set to
  let origin = dashboardUrl;
  try { origin = new URL(dashboardUrl).origin; } catch(e) { /* use as-is */ }

  // EOM review → /review (last month's final figures)
  // Everything else → root (Revenue & Invoicing live page)
  const linkUrl = periodPosition === 'eom' ? `${origin}/review` : origin;

  const isFinal = periodPosition === 'eom';
  const tsgLabel = isFinal ? 'Invoiced' : 'Position';
  const headlineLabel = isFinal ? 'Final Invoiced' : 'Monthly Position';
  const subLabel = periodLabel(periodPosition);

  // Font stack: Inter via Google Fonts where supported, system fallback elsewhere.
  const fontStack = `'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`;

  // ── 1. HERO KPI BLOCK ──────────────────────────────────────────────────────
  // The big headline number — combined position vs combined target.
  let heroBlock = '';
  if (brandSummary) {
    const overall       = calcOverall(brandSummary);
    const overallTarget = brandSummary.overallTarget || 0;
    const diff          = overallTarget ? overall - overallTarget : null;
    const diffPct       = overallTarget ? (overall / overallTarget * 100) : null;

    const diffStr   = diff === null ? '' : (diff >= 0 ? '+' : '−') + f(Math.abs(diff));
    const diffColor = diff === null ? '#94a3b8' : (diff >= 0 ? '#16a34a' : '#dc2626');
    const arrow     = diff === null ? '' : (diff >= 0 ? '▲' : '▼');

    heroBlock = `
    <!-- Hero KPI -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 32px 0;">
      <tr>
        <td style="padding:0;">
          <div style="font-family:${fontStack}; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:1.2px; color:#64748b; margin-bottom:10px;">
            ${headlineLabel}${subLabel && !isFinal ? ' &middot; ' + subLabel : ''}
          </div>
          <div style="font-family:${fontStack}; font-size:44px; font-weight:800; color:#0f172a; letter-spacing:-1.2px; line-height:1; margin-bottom:8px;">
            ${f(overall)}
          </div>
          ${overallTarget ? `
          <div style="font-family:${fontStack}; font-size:14px; color:#475569; line-height:1.5;">
            <span style="color:${diffColor}; font-weight:600;">${arrow} ${diffStr}</span>
            <span style="color:#94a3b8;"> &middot; ${f(overallTarget)} target</span>
            ${diffPct !== null ? `<span style="color:#94a3b8;"> &middot; ${diffPct.toFixed(0)}% of target</span>` : ''}
          </div>` : ''}
        </td>
      </tr>
    </table>`;
  }

  // ── 2. BRAND CARDS ─────────────────────────────────────────────────────────
  // Three mini cards side-by-side in a table row. Each shows brand, big value,
  // value-label, target underneath, and +/- delta in colour.
  let brandCards = '';
  if (brandSummary) {
    const brands = [
      { label: 'TSG', val: brandSummary.tsg || 0, target: brandSummary.tsgTarget || 0, accent: '#16a34a', valueLabel: tsgLabel },
      { label: 'WLL', val: brandSummary.wll || 0, target: brandSummary.wllTarget || 0, accent: '#2563eb', valueLabel: 'Invoiced' },
      { label: 'NV',  val: brandSummary.nv  || 0, target: brandSummary.nvTarget  || 0, accent: '#db2777', valueLabel: 'Invoiced' },
    ];

    const cells = brands.map((b, i) => {
      const diff      = b.target ? b.val - b.target : null;
      const diffStr   = diff === null ? '—' : (diff >= 0 ? '+' : '−') + f(Math.abs(diff));
      const diffColor = diff === null ? '#94a3b8' : (diff >= 0 ? '#16a34a' : '#dc2626');
      const spacer    = i < brands.length - 1 ? '<td width="12" style="font-size:0; line-height:0;">&nbsp;</td>' : '';
      return `
        <td valign="top" width="33%" style="padding:0;">
          <div style="background:#fafafa; border:1px solid #e5e7eb; border-radius:10px; padding:18px 18px 16px;">
            <div style="font-family:${fontStack}; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:1.4px; color:${b.accent}; margin-bottom:10px;">${b.label}</div>
            <div style="font-family:${fontStack}; font-size:21px; font-weight:800; color:#0f172a; letter-spacing:-0.5px; line-height:1; margin-bottom:6px;">${f(b.val)}</div>
            <div style="font-family:${fontStack}; font-size:10px; color:#94a3b8; margin-bottom:14px; text-transform:uppercase; letter-spacing:0.6px;">${b.valueLabel}</div>
            <div style="font-family:${fontStack}; font-size:12px; color:#64748b; line-height:1.4;">
              <span style="color:${diffColor}; font-weight:600;">${diffStr}</span>
              ${b.target ? `<br><span style="color:#94a3b8;">vs ${f(b.target)} target</span>` : ''}
            </div>
          </div>
        </td>${spacer}`;
    }).join('');

    brandCards = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 32px 0;">
      <tr>${cells}</tr>
    </table>`;
  }

  // ── 3. NEW ORDERS STATS BAR ────────────────────────────────────────────────
  let ordersBar = '';
  if (salesSummary && salesSummary.totalOrders > 0) {
    const conv = salesSummary.totalEnquiries > 0
      ? Math.round(salesSummary.totalOrders / salesSummary.totalEnquiries * 100)
      : 0;

    const stats = [
      { label: 'New Orders', value: f(salesSummary.totalNewSales) },
      { label: 'Won',        value: salesSummary.totalOrders },
      { label: 'Enquiries',  value: salesSummary.totalEnquiries },
      { label: 'Conversion', value: conv + '%' },
    ];

    const cells = stats.map((s, i) => {
      const borderStyle = i < stats.length - 1 ? 'border-right:1px solid #e5e7eb;' : '';
      return `
      <td style="padding:18px 8px; ${borderStyle} text-align:center;">
        <div style="font-family:${fontStack}; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:1.2px; color:#64748b; margin-bottom:6px;">${s.label}</div>
        <div style="font-family:${fontStack}; font-size:20px; font-weight:800; color:#0f172a; letter-spacing:-0.4px;">${s.value}</div>
      </td>`;
    }).join('');

    ordersBar = `
    <div style="font-family:${fontStack}; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:1.2px; color:#64748b; margin:0 0 12px 0;">New Sales Orders</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 36px 0; border:1px solid #e5e7eb; border-radius:10px; background:#ffffff;">
      <tr>${cells}</tr>
    </table>`;
  }

  // ── 4. COMMENTARY ──────────────────────────────────────────────────────────
  // Parse the plain-text commentary into HTML. ## headings and **HEADING** on
  // their own line become styled section breaks. Body prose gets generous
  // line-height for readability.
  const commentaryHtml = commentary
    .split('\n\n')
    .map(block => block.trim())
    .filter(block => block.length > 0)
    .map(block => {
      // ## heading style section break
      if (block.startsWith('## ')) {
        const heading = block.replace(/^## /, '');
        return `
        <div style="font-family:${fontStack}; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:1.3px; color:#0f172a; margin:28px 0 14px 0;">${heading}</div>`;
      }
      // **HEADING** on its own line (no other text) → also a section heading
      const boldOnly = block.match(/^\*\*([^*]+)\*\*$/);
      if (boldOnly) {
        return `
        <div style="font-family:${fontStack}; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:1.3px; color:#0f172a; margin:28px 0 14px 0;">${boldOnly[1]}</div>`;
      }
      // Regular paragraph
      let p = block
        .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#0f172a; font-weight:600;">$1</strong>')
        .replace(/\n/g, '<br>');
      return `<p style="font-family:${fontStack}; margin:0 0 16px 0; font-size:14.5px; line-height:1.75; color:#334155;">${p}</p>`;
    })
    .join('');

  // ── 5. DASHBOARD BUTTON ────────────────────────────────────────────────────
  const dashboardButton = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 0;">
      <tr>
        <td align="center" bgcolor="#0f172a" style="border-radius:8px;">
          <a href="${linkUrl}"
             style="display:inline-block; background:#0f172a; color:#ffffff; text-decoration:none;
                    padding:14px 30px; border-radius:8px; font-family:${fontStack};
                    font-size:13px; font-weight:600; letter-spacing:0.2px;">
            View Full Dashboard &nbsp;&rarr;
          </a>
        </td>
      </tr>
    </table>`;

  // ── 6. ASSEMBLE ────────────────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <title>TSG Sales Update — ${monthCovered}</title>
  <!--[if mso]>
  <style type="text/css">
    body, table, td { font-family: Arial, sans-serif !important; }
  </style>
  <![endif]-->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
</head>
<body style="margin:0; padding:0; background:#f1f5f9; font-family:${fontStack}; color:#0f172a; -webkit-font-smoothing:antialiased;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f1f5f9;">
    <tr>
      <td align="center" style="padding:32px 16px;">

        <!-- Outer wrapper, max 660px -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="660" style="max-width:660px; width:100%;">

          <!-- Tiny brand strip above the card -->
          <tr>
            <td style="padding:0 4px 14px 4px;">
              <div style="font-family:${fontStack}; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:2px; color:#94a3b8;">
                The Sign Group &middot; Sales Report
              </div>
            </td>
          </tr>

          <!-- Main white card -->
          <tr>
            <td style="background:#ffffff; border-radius:14px; padding:0; border:1px solid #e2e8f0;">

              <!-- Dark header strip inside the card -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="background:#0f172a; padding:32px 40px; border-radius:14px 14px 0 0;">
                    <div style="font-family:${fontStack}; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:1.6px; color:#94a3b8; margin-bottom:8px;">
                      Sales Update${subLabel ? ' &middot; ' + subLabel : ''}
                    </div>
                    <div style="font-family:${fontStack}; font-size:28px; font-weight:800; color:#ffffff; letter-spacing:-0.6px; line-height:1.15;">
                      ${monthCovered || 'Monthly Report'}
                    </div>
                  </td>
                </tr>
              </table>

              <!-- Body content, generous padding -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="padding:36px 40px 32px;">

                    ${heroBlock}

                    ${brandCards}

                    ${ordersBar}

                    <!-- Soft divider -->
                    <div style="height:1px; background:#e2e8f0; margin:8px 0 28px;"></div>

                    ${commentaryHtml}

                    <!-- Soft divider before button -->
                    <div style="height:1px; background:#e2e8f0; margin:32px 0 28px;"></div>

                    ${dashboardButton}

                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- Footer below the card -->
          <tr>
            <td style="padding:20px 8px 0;">
              <div style="font-family:${fontStack}; font-size:11px; color:#94a3b8; text-align:center; line-height:1.7;">
                Generated from the
                <a href="${linkUrl}" style="color:#64748b; text-decoration:underline;">TSG Sales Dashboard</a>.
                AI-assisted summary based on live Airtable data.
              </div>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}
