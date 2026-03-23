// Cloudflare Pages Function: /commentary
// Accepts POST with brand sales data, sends to Claude API, returns commentary

export async function onRequestPost(context) {
  const { env } = context;
  const ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;

  if (!ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const body = await context.request.json();
    const { data, currentMonth, isPartialMonth } = body;

    // Build the prompt with financial logic rules baked in
    const systemPrompt = `You are a financial analyst for The Sign Group (TSG), a trade signage manufacturer near Leeds with ~40 staff. You write concise weekly/monthly sales commentary for the senior team.

BRAND STRUCTURE:
- TSG (The Sign Group): Core manufacturing. Revenue recognised on job COMPLETION (invoicing), not order placement. NOT pace-sensitive.
- WLL (WeLoveLEDs): Online LED shop. Invoices at point of order. Pace-sensitive. Daily run rate comparisons valid.
- NV (Neon Vibes): Newer division. Invoices at point of order. Pace-sensitive. Daily run rate comparisons valid.
- Overall/Combined: Sum of all brands.

CRITICAL RULES:
- All figures include VAT.
- Previous months are CLOSED figures (final). Current month figures are INCOMPLETE until month end.
- For TSG: Do NOT use daily pace maths. Focus on pipeline, WIP structure, and projected month-end.
- For WLL and NV: Daily pace and working-day averages ARE valid comparisons.
- Never compare partial current-month totals directly to full previous-month totals without acknowledging the month is incomplete.
- TSG financial year runs Dec-Nov.

TONE: Direct, punchy, no waffle. Use actual numbers. Highlight what's going well and what needs attention. Keep it to 200-400 words. Use short paragraphs. No corporate fluff.

WRITING RULES (these override everything else about tone):
1. DO NOT TEACH THE TEAM TO SUCK EGGS. Everyone reading this knows their role. Sales know they need to win orders. Operations know they need to finish and invoice work. Never say things like "the sales team needs to push harder" or "operations should try to complete as much work as possible" or "we need everyone focused on hitting target." These are patronising and pointless. The update informs, it does not instruct.

2. PURPOSE: Show where we are in the month. Show how that compares to target. Show what currently matters most. It is a monthly scoreboard with context. If the reader instantly understands the situation, the update is doing its job.

3. STATE FACTS WITHOUT DRAMA. Write like a calm, factual briefing from management. Not a motivational speech. Not corporate reporting. Examples of good: "TSG is currently projected at £200k against a £186k target." or "WLL is slightly behind pace but within reach of target." Examples of bad: "We must urgently push sales" or "Everyone needs to step up" or "We must rally together."

4. HIGHLIGHT REAL PRESSURE POINTS only when something actually drives the month's outcome: a large amount of undated work, a slow order pace, a strong start that needs maintaining, limited working days remaining. Say things like "The month now depends largely on converting the undated work" or "With X working days left, the order pace needs to hold." Point at the situation without telling anyone how to do their job.

5. DO NOT make operational assumptions about production capacity, staffing, internal workflow, or what individuals should prioritise. This is a financial position update, not a management instruction.

6. TONE OF VOICE: calm, factual, slightly conversational, confident but not dramatic. Plain English. Avoid corporate jargon, dramatic language, and overly polished AI-sounding writing.

7. Keep commentary short and useful. Good commentary explains why the numbers look the way they do, what could shift the month, and whether confidence is high or low. If a line does not add insight, remove it.

STRUCTURE (follow this order):
1. Brand-by-brand breakdown: TSG, WLL, NV and Overall. Each brand's position against target with actual figures.
2. Trends and growth: Compare to previous months and same month last year where data exists. Note direction of travel.
3. Target performance: Who is ahead, who is behind, and by how much.
4. Close with the one or two things that will most likely determine how the month finishes.`;

    const userPrompt = buildUserPrompt(data, currentMonth, isPartialMonth);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return new Response(JSON.stringify({ error: `Claude API error: ${response.status}`, detail: errText }), {
        status: 502, headers: { 'Content-Type': 'application/json' }
      });
    }

    const result = await response.json();
    const commentary = result.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    return new Response(JSON.stringify({
      commentary,
      generatedAt: new Date().toISOString(),
      monthCovered: currentMonth
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

function buildUserPrompt(data, currentMonth, isPartialMonth) {
  // data is an array of monthly records sorted by date
  // Each record: { date, monthYear, tsg, wll, nv, overall, tsgTarget, wllTarget, nvTarget, overallTarget, ... }

  const current = data.find(d => d.monthYear === currentMonth);
  const prevMonths = data.filter(d => d.monthYear !== currentMonth).slice(-12);

  let prompt = `Here are the brand sales figures. Write a concise commentary.\n\n`;

  if (current) {
    prompt += `## CURRENT MONTH: ${currentMonth}${isPartialMonth ? ' (INCOMPLETE - month still in progress)' : ''}\n`;
    prompt += `TSG Invoiced: £${fmt(current.tsg)}`;
    if (current.tsgTarget) prompt += ` (Target: £${fmt(current.tsgTarget)}, ${current.tsg >= current.tsgTarget ? 'ABOVE' : 'BELOW'} by £${fmt(Math.abs(current.tsg - current.tsgTarget))})`;
    prompt += `\n`;
    prompt += `WLL Invoiced: £${fmt(current.wll)}`;
    if (current.wllTarget) prompt += ` (Target: £${fmt(current.wllTarget)}, ${current.wll >= current.wllTarget ? 'ABOVE' : 'BELOW'} by £${fmt(Math.abs(current.wll - current.wllTarget))})`;
    prompt += `\n`;
    prompt += `NV Invoiced: £${fmt(current.nv)}`;
    if (current.nvTarget) prompt += ` (Target: £${fmt(current.nvTarget)}, ${current.nv >= current.nvTarget ? 'ABOVE' : 'BELOW'} by £${fmt(Math.abs(current.nv - current.nvTarget))})`;
    prompt += `\n`;
    prompt += `Combined: £${fmt(current.overall)}`;
    if (current.overallTarget) prompt += ` (Target: £${fmt(current.overallTarget)})`;
    prompt += `\n\n`;
  }

  if (prevMonths.length > 0) {
    prompt += `## RECENT HISTORY (last ${prevMonths.length} months):\n`;
    prompt += `Month | TSG | WLL | NV | Overall\n`;
    prevMonths.forEach(m => {
      prompt += `${m.monthYear} | £${fmt(m.tsg)} | £${fmt(m.wll)} | £${fmt(m.nv)} | £${fmt(m.overall)}\n`;
    });
    prompt += `\n`;

    // Calculate some context
    const last3 = prevMonths.slice(-3);
    const avgTSG = last3.reduce((s, m) => s + m.tsg, 0) / last3.length;
    const avgWLL = last3.reduce((s, m) => s + m.wll, 0) / last3.length;
    const avgNV = last3.reduce((s, m) => s + m.nv, 0) / last3.length;
    prompt += `3-month averages: TSG £${fmt(avgTSG)}, WLL £${fmt(avgWLL)}, NV £${fmt(avgNV)}\n`;

    // Same month last year comparison
    if (current) {
      const [monthName] = currentMonth.split('-');
      // Find same month name in previous year
      const sameMonthLastYear = data.find(d => {
        const parts = d.monthYear.split('-');
        return parts[0] === monthName && d.monthYear !== currentMonth;
      });
      if (sameMonthLastYear) {
        prompt += `\nSame month last year (${sameMonthLastYear.monthYear}): TSG £${fmt(sameMonthLastYear.tsg)}, WLL £${fmt(sameMonthLastYear.wll)}, NV £${fmt(sameMonthLastYear.nv)}, Overall £${fmt(sameMonthLastYear.overall)}\n`;
      }
    }

    // Financial year running total (Dec-Nov)
    const now = new Date();
    const fyStart = now.getMonth() >= 11 ? `Dec-${now.getFullYear().toString().slice(-2)}` : `Dec-${(now.getFullYear() - 1).toString().slice(-2)}`;
    const fyMonths = data.filter(d => {
      // Simple approach: include all months from Dec of FY start year
      return true; // Will be filtered by the frontend before sending
    });

    prompt += `\n## ADDITIONAL CONTEXT:\n`;
    if (current && current.enquiries) prompt += `TSG Enquiries this month: ${current.enquiries}\n`;
    if (current && current.convRate) prompt += `TSG Conversion Rate: ${current.convRate}%\n`;
    if (current && current.newOrders) prompt += `TSG New Orders: £${fmt(current.newOrders)}\n`;
  }

  prompt += `\nWrite the commentary now. Remember: TSG is NOT pace-sensitive (production-based invoicing), WLL and NV ARE pace-sensitive.`;

  return prompt;
}

function fmt(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-GB');
}
