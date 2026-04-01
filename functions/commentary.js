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
    const { data, currentMonth, isPartialMonth, periodPosition, userContext, salesTeamData } = body;

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

8. SALES TEAM SECTION — NAME NAMES. When covering individual sales performance, use actual names and actual numbers. If someone has had a strong month relative to their own average, say so clearly. If someone is significantly below their own norm, note it factually. Do not hedge. Do not use vague team language like "the team performed well overall." Compare each person to their own recent average — that is the only fair benchmark. This should read like a factual peer review, not a PR piece.

STRUCTURE (follow this order):
1. Brand-by-brand breakdown (invoiced): TSG, WLL, NV and Overall. Each brand's position against target with actual figures.
2. New sales orders: Total new orders confirmed this month and how that compares to recent months.
3. Sales team performance: Individual breakdown — who won what, enquiry volumes, conversion rates. Compare each person to their own 3-month average. Name who is above and below their own norm, and by how much.
4. Trends and growth: Direction of travel vs previous months and same month last year where data exists.
5. Close with the one or two things that will most likely determine how the month finishes (or, for EOM, a one-line verdict on the month).`;

    const userPrompt = buildUserPrompt(data, currentMonth, isPartialMonth, periodPosition, userContext, salesTeamData);

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

function buildUserPrompt(data, currentMonth, isPartialMonth, periodPosition, userContext, salesTeamData) {
  const current = data.find(d => d.monthYear === currentMonth);
  const prevMonths = data.filter(d => d.monthYear !== currentMonth).slice(-12);

  function calcOverall(d) {
    return d.overall > 0 ? d.overall : (d.tsg + d.wll + d.nv + (d.other || 0));
  }

  let prompt = `Here are the brand sales figures. Write a concise commentary.\n\n`;

  // ── PERIOD POSITION ──────────────────────────────────────────────────────────
  // Tells the AI where in the month we are, which shapes what's relevant to say
  // and the framing of the commentary (looking ahead vs wrapping up).
  const periodGuidance = {
    'start': `PERIOD CONTEXT: This is a start-of-month update. Figures will be low and incomplete — that is expected. Frame this as an early read on how the month has opened. Compare the opening pace to where this month started last year. Keep projections cautious. The focus should be on the order pipeline and early indicators, not the invoiced totals which are naturally low at this stage.`,
    'mid':   `PERIOD CONTEXT: This is a mid-month check-in. Figures represent roughly half the month. Assess whether the current pace puts each brand on track or off track to hit target. Highlight the gap still to close (or surplus already built) and what that implies for the second half. For TSG, focus on what is in the pipeline that could complete before month-end.`,
    'final-week': `PERIOD CONTEXT: This is a final-week update. The shape of the month is now largely set. Flag clearly which brands are on track, which are behind and by how much, and whether the gap is realistically closeable. For TSG specifically, reference any known WIP that is due to complete before month-end. Keep the tone factual — this is where it either comes together or it doesn't.`,
    'eom':   `PERIOD CONTEXT: These are end-of-month or final figures. The month is complete (or effectively complete). Write this as a definitive wrap-up. No forward-looking projections needed — just a clear summary of how the month landed against target, what the YoY and MoM trends show, and a brief note on what the result means in context. Confident, conclusive tone.`
  };

  const guidance = periodGuidance[periodPosition] || periodGuidance['eom'];
  prompt += `## PERIOD POSITION:\n${guidance}\n\n`;
  // ────────────────────────────────────────────────────────────────────────────

  // User context
  if (userContext) {
    prompt += `## ADDITIONAL CONTEXT FROM MANAGEMENT:\n${userContext}\n\nIncorporate the above context naturally into the commentary where relevant.\n\n`;
  }

  if (current) {
    const overall = calcOverall(current);
    prompt += `## CURRENT MONTH INVOICED SALES: ${currentMonth}${isPartialMonth ? ' (INCOMPLETE - month still in progress)' : ' (FINAL FIGURES)'}\n`;
    prompt += `These are INVOICED figures (completed work). This is separate from new orders placed.\n`;
    prompt += `TSG Invoiced: £${fmt(current.tsg)}`;
    if (current.tsgTarget) prompt += ` (Target: £${fmt(current.tsgTarget)}, ${current.tsg >= current.tsgTarget ? 'ABOVE' : 'BELOW'} by £${fmt(Math.abs(current.tsg - current.tsgTarget))})`;
    prompt += `\n`;
    prompt += `WLL Invoiced: £${fmt(current.wll)}`;
    if (current.wllTarget) prompt += ` (Target: £${fmt(current.wllTarget)}, ${current.wll >= current.wllTarget ? 'ABOVE' : 'BELOW'} by £${fmt(Math.abs(current.wll - current.wllTarget))})`;
    prompt += `\n`;
    prompt += `NV Invoiced: £${fmt(current.nv)}`;
    if (current.nvTarget) prompt += ` (Target: £${fmt(current.nvTarget)}, ${current.nv >= current.nvTarget ? 'ABOVE' : 'BELOW'} by £${fmt(Math.abs(current.nv - current.nvTarget))})`;
    prompt += `\n`;
    prompt += `Combined Invoiced: £${fmt(overall)}`;
    if (current.overallTarget) prompt += ` (Target: £${fmt(current.overallTarget)})`;
    prompt += `\n\n`;
  }

  // NEW SALES ORDERED — team total + individual breakdown with historical context
  if (salesTeamData && (salesTeamData.totalNewSales > 0 || salesTeamData.totalOrders > 0)) {
    prompt += `## NEW SALES ORDERED THIS MONTH (orders placed, NOT invoiced):\n`;
    prompt += `IMPORTANT: New Sales are orders confirmed this month. This is order intake, completely separate from invoiced revenue above.\n`;

    prompt += `Team Total: £${fmt(salesTeamData.totalNewSales)}`;
    if (salesTeamData.prevMonthNewSales > 0) {
      const pct = ((salesTeamData.totalNewSales - salesTeamData.prevMonthNewSales) / salesTeamData.prevMonthNewSales * 100);
      prompt += ` (${pct >= 0 ? '+' : ''}${pct.toFixed(0)}% vs previous month's £${fmt(salesTeamData.prevMonthNewSales)})`;
    }
    prompt += `\n`;
    prompt += `Total Enquiries: ${salesTeamData.totalEnquiries} | Total Orders: ${salesTeamData.totalOrders}\n\n`;

    // Team history (prior 3 months totals)
    if (salesTeamData.teamHistory && salesTeamData.teamHistory.length > 0) {
      prompt += `Team new sales — recent months:\n`;
      salesTeamData.teamHistory.forEach(h => {
        prompt += `  ${h.month}: £${fmt(h.newSales)} from ${h.orders} orders (${h.enquiries} enquiries)\n`;
      });
      prompt += `\n`;
    }

    // Individual breakdown with vs-their-own-average context
    if (salesTeamData.employees && salesTeamData.employees.length > 0) {
      prompt += `Individual performance this month vs their own 3-month average:\n`;
      salesTeamData.employees.forEach(e => {
        const salesVsAvg = e.avgSales > 0 ? ((e.newSales - e.avgSales) / e.avgSales * 100) : null;
        const convVsAvg  = e.avgConv  > 0 ? ((e.convRate - e.avgConv)  / e.avgConv  * 100) : null;

        prompt += `\n${e.name}:\n`;
        prompt += `  This month: £${fmt(e.newSales)} | ${e.orders} orders from ${e.enquiries} enquiries | ${(e.convRate * 100).toFixed(0)}% conversion | AOV £${fmt(e.aov)}\n`;

        if (e.histMonthsCount > 0) {
          prompt += `  3-month avg:  £${fmt(e.avgSales)} | ${e.avgOrders.toFixed(1)} orders avg | ${(e.avgConv * 100).toFixed(0)}% conversion avg | AOV £${fmt(e.avgAOV)}\n`;
          if (salesVsAvg !== null) {
            const dir = salesVsAvg >= 0 ? 'ABOVE' : 'BELOW';
            prompt += `  vs own avg: ${dir} by ${Math.abs(salesVsAvg).toFixed(0)}% on new sales`;
            if (convVsAvg !== null) prompt += `, ${convVsAvg >= 0 ? 'ABOVE' : 'BELOW'} by ${Math.abs(convVsAvg).toFixed(0)}% on conversion`;
            prompt += `\n`;
          }

          // Last 3 months detail for this person
          if (e.history && e.history.length > 0) {
            prompt += `  Recent months: `;
            prompt += e.history.map(h => `${h.month}: £${fmt(h.newSales)} (${h.orders} orders, ${(h.convRate*100).toFixed(0)}% conv)`).join(' | ');
            prompt += `\n`;
          }
        }
      });
      prompt += `\n`;
    }
  }

  if (prevMonths.length > 0) {
    prompt += `## RECENT INVOICING HISTORY (last ${prevMonths.length} months):\n`;
    prompt += `Month | TSG | WLL | NV | Overall\n`;
    prevMonths.forEach(m => {
      prompt += `${m.monthYear} | £${fmt(m.tsg)} | £${fmt(m.wll)} | £${fmt(m.nv)} | £${fmt(calcOverall(m))}\n`;
    });
    prompt += `\n`;

    const last3 = prevMonths.slice(-3);
    const avgTSG = last3.reduce((s, m) => s + m.tsg, 0) / last3.length;
    const avgWLL = last3.reduce((s, m) => s + m.wll, 0) / last3.length;
    const avgNV  = last3.reduce((s, m) => s + m.nv,  0) / last3.length;
    prompt += `3-month invoicing averages: TSG £${fmt(avgTSG)}, WLL £${fmt(avgWLL)}, NV £${fmt(avgNV)}\n`;

    // Same month last year
    if (current) {
      const monthPart = currentMonth.split('-')[0];
      const sameMonthLastYear = [...data].reverse().find(d => {
        const parts = d.monthYear.split('-');
        return parts[0] === monthPart && d.monthYear !== currentMonth;
      });
      if (sameMonthLastYear) {
        prompt += `\nSame month last year (${sameMonthLastYear.monthYear}): TSG £${fmt(sameMonthLastYear.tsg)}, WLL £${fmt(sameMonthLastYear.wll)}, NV £${fmt(sameMonthLastYear.nv)}, Overall £${fmt(calcOverall(sameMonthLastYear))}\n`;
      }
    }
  }

  prompt += `\nWrite the commentary now. Remember:
- TSG invoicing is NOT pace-sensitive (production-based). WLL and NV ARE pace-sensitive.
- Keep INVOICED sales and NEW SALES ORDERED clearly separated in the commentary. They are different things.
- New Sales Ordered is the pipeline being filled. Invoiced Sales is revenue being realised.
- For the sales team section, use actual names and compare each person to their own 3-month average — not to the team or to each other.
- Apply the period context guidance above — it should shape the framing and tone of the whole piece.`;

  return prompt;
}

function fmt(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-GB');
}
