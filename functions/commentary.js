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

4. HIGHLIGHT REAL PRESSURE POINTS only when something actually drives the month's outcome. Point at the situation without telling anyone how to do their job.

5. DO NOT make operational assumptions about production capacity, staffing, internal workflow, or what individuals should prioritise. This is a financial position update, not a management instruction.

6. TONE OF VOICE: calm, factual, slightly conversational, confident but not dramatic. Plain English. Avoid corporate jargon, dramatic language, and overly polished AI-sounding writing.

7. Keep commentary short and useful. If a line does not add insight, remove it.

8. USER CONTEXT IS PRIMARY MATERIAL, NOT A FOOTNOTE. If the person generating this report has provided additional context — absences, retirements, production pressures, upcoming challenges — this is real first-hand information that explains the numbers. Weave it in naturally and prominently where it is relevant. Do not park it at the end or treat it as a rider. If someone was absent for the final week, say so where it explains their numbers. If there was a staffing challenge in the workshop, say so where it explains the invoicing result.

9. RANK INDIVIDUALS BY OUTPUT. List individuals in order of their new sales value this month, highest first. The top earner is the lead story — frame them as such. If their conversion rate dropped slightly, note it separately and briefly. Do not let a minor metric caveat undermine the framing of the top result. A person who won the most deserves to be described as the top earner first, before anything else.

10. CONVERSION RATE NUANCE. Differences in conversion rates between team members are worth noting — a lower rate means the same enquiry pool would yield more orders if converted at the higher rate. However: (a) conversion rates can improve retrospectively as previously quoted work gets confirmed in subsequent months, so a low rate this month may not be final; (b) only flag conversion as a concern when there is a meaningful and sustained gap between one person and the rest of the team; (c) do not frame a single month's conversion dip as a problem unless it fits a clear pattern. Monitor, note, but do not alarm.

11. HISTORICAL CONTEXT MATTERS. You have up to 6 months of individual history. Use it. A result that looks exceptional against a 3-month low baseline may be less impressive against a 6-month view — acknowledge this where relevant. A good month following several weak months is a recovery, not a new benchmark. Say so. Conversely, a strong result that holds up even across the longer window deserves to be called out clearly.

STRUCTURE (follow this order):
1. Brand-by-brand breakdown (invoiced): TSG, WLL, NV and Overall. Each brand's position against target with actual figures.
2. New sales orders: Total new orders confirmed this month and how that compares to recent months.
3. Sales team performance: List individuals by this month's sales value, highest first. For each: what they won, how that compares to their 6-month average, and any relevant context (absences, patterns). Note meaningful conversion rate differences across the team factually and with the caveat about retrospective confirmation.
4. Trends and growth: Direction of travel vs previous months and same month last year where data exists.
5. Close with the one or two things that will most likely determine how the month finishes (or, for EOM, a brief one-line verdict and what the result sets up for next month — particularly if the user context mentions upcoming challenges).`;

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
    'start': `PERIOD CONTEXT: This is a start-of-month update covering only the first few working days. The figures are tiny and almost meaningless in isolation — that is completely expected and normal.

STRICT RULES FOR START-OF-MONTH:
- DO NOT compare current MTD invoiced totals or order values to last month's full figures. Saying "orders are down 83% vs March" on day 2 is not a meaningful statement and must not appear.
- DO NOT compare individual sales performance to their monthly averages. Two days of data tells you nothing about how someone's month is going.
- DO NOT draw any conclusions about whether the month is on track or behind — it is far too early.
- DO NOT project or extrapolate from current figures.
- TSG invoicing in the first few days reflects jobs that happened to complete early — it has no predictive value yet.

WHAT TO WRITE INSTEAD:
- Briefly note what figures exist so far purely as a factual record, without any comparative judgement.
- The most useful content at this stage is: what pipeline is coming in to the month? What did last month close at and does that create a good or difficult starting position for production? Are there any known large jobs or events that will shape this month?
- For the sales team section: conversion rate in the first couple of days is based on a tiny sample and should not be analysed as meaningful. Note order intake volume briefly and leave it at that.
- Close with what to watch as the month develops — not conclusions about where it currently stands.
- Keep this update short. Two days in, there is not much to say and that is fine.`,

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

    // Individual breakdown — sorted by this month's sales, highest first
    if (salesTeamData.employees && salesTeamData.employees.length > 0) {
      const sorted = [...salesTeamData.employees].sort((a, b) => b.newSales - a.newSales);
      prompt += `Individual performance this month vs their own 6-month average (list in this order — highest earner first):\n`;
      sorted.forEach(e => {
        const salesVsAvg = e.avgSales > 0 ? ((e.newSales - e.avgSales) / e.avgSales * 100) : null;
        const convVsAvg  = e.avgConv  > 0 ? ((e.convRate - e.avgConv)  / e.avgConv  * 100) : null;

        prompt += `\n${e.name}:\n`;
        prompt += `  This month: £${fmt(e.newSales)} | ${e.orders} orders from ${e.enquiries} enquiries | ${(e.convRate * 100).toFixed(0)}% conversion | AOV £${fmt(e.aov)}\n`;

        if (e.histMonthsCount > 0) {
          prompt += `  ${e.histMonthsCount}-month avg: £${fmt(e.avgSales)} sales | ${e.avgOrders.toFixed(1)} orders avg | ${(e.avgConv * 100).toFixed(0)}% conversion avg | AOV £${fmt(e.avgAOV)}\n`;
          if (salesVsAvg !== null) {
            const dir = salesVsAvg >= 0 ? 'ABOVE' : 'BELOW';
            prompt += `  vs own avg: ${dir} by ${Math.abs(salesVsAvg).toFixed(0)}% on new sales`;
            if (convVsAvg !== null) prompt += `, ${convVsAvg >= 0 ? 'ABOVE' : 'BELOW'} by ${Math.abs(convVsAvg).toFixed(0)}% on conversion`;
            prompt += `\n`;
          }

          // Month-by-month breakdown for context
          if (e.history && e.history.length > 0) {
            prompt += `  Recent months: `;
            prompt += e.history.map(h => `${h.month}: £${fmt(h.newSales)} (${h.orders} orders, ${(h.convRate*100).toFixed(0)}% conv)`).join(' | ');
            prompt += `\n`;
          }
        }
      });

      // Team conversion rate comparison — flag meaningful gaps
      const convRates = sorted.map(e => ({ name: e.name, conv: (e.convRate * 100).toFixed(0) }));
      prompt += `\nTeam conversion rates this month: ${convRates.map(c => `${c.name}: ${c.conv}%`).join(' | ')}\n`;
      prompt += `NOTE: Conversion rates can shift in subsequent months as previously quoted work gets confirmed. A lower rate this month may not be the final picture. Flag persistent gaps across the team, but with that caveat.\n`;
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
- Keep INVOICED sales and NEW SALES ORDERED clearly separated. They are different things.
- List individuals highest earner first. Frame the top earner as the top earner.
- Use the 6-month history to give context — a good month after a weak run is a recovery, not a benchmark.
- Weave in any user context (absences, retirements, upcoming challenges) naturally where it explains the numbers.
- Note conversion rate differences across the team factually, with the caveat that rates can shift as old quotes confirm.
- Apply the period context guidance strictly — especially for start-of-month where MoM and individual comparisons are explicitly banned.`;

  return prompt;
}

function fmt(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-GB');
}
