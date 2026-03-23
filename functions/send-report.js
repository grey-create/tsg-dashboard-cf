// Cloudflare Pages Function: /send-report
// Sends the generated commentary via Resend email API

export async function onRequestPost(context) {
  const { env } = context;
  const RESEND_API_KEY = env.RESEND_API_KEY;
  const REPORT_FROM_EMAIL = env.REPORT_FROM_EMAIL || 'reports@thesigngroup.co.uk';

  if (!RESEND_API_KEY) {
    return new Response(JSON.stringify({ error: 'RESEND_API_KEY not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const body = await context.request.json();
    const { commentary, recipients, subject, monthCovered } = body;

    if (!commentary || !recipients || recipients.length === 0) {
      return new Response(JSON.stringify({ error: 'Missing commentary or recipients' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    // Convert commentary to simple HTML email
    const htmlBody = buildEmailHtml(commentary, monthCovered);

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

function buildEmailHtml(commentary, monthCovered) {
  // Convert markdown-ish text to HTML paragraphs
  const paragraphs = commentary
    .split('\n\n')
    .map(p => p.trim())
    .filter(p => p.length > 0)
    .map(p => {
      // Bold markers
      p = p.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      // Line breaks within paragraphs
      p = p.replace(/\n/g, '<br>');
      return `<p style="margin: 0 0 14px 0; line-height: 1.6;">${p}</p>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px; color: #111; background: #f8f8f8;">
  <div style="background: #000; color: #fff; padding: 20px 24px; border-radius: 8px 8px 0 0;">
    <h1 style="margin: 0; font-size: 18px; font-weight: 700;">TSG Sales Update</h1>
    <p style="margin: 4px 0 0 0; font-size: 13px; color: #999;">${monthCovered || 'Monthly Report'}</p>
  </div>
  <div style="background: #fff; padding: 24px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 8px 8px;">
    ${paragraphs}
    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
    <p style="font-size: 11px; color: #999; margin: 0;">Generated from TSG Sales Dashboard. This is an AI-assisted summary based on live Airtable data.</p>
  </div>
</body>
</html>`;
}
