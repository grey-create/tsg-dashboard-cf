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
    const { data, currentMonth, isPartialMonth, periodPosition, monthMeta, userContext, salesTeamData } = body;

    const systemPrompt = `You are a financial analyst for The Sign Group (TSG), a trade signage manufacturer near Leeds with ~40 staff. You write concise weekly/monthly sales commentary for the senior team.

AUDIENCE — THIS DRIVES TONE:
The primary readers are TSG Operations and TSG Sales. TSG invoicing (jobs completed + dated WIP) is what drives the business — the production team affects that directly, and the sales team feeds it via new orders. Frame the commentary around what those two teams need to know: how TSG is tracking and what's in the pipeline. Spend most of the words there.

WLL and NV are e-commerce brands. Their numbers can swing wildly — they could sell their entire target on the last day, or have a quiet stretch and recover the next week. Don't attempt motivational tone, pace coaching, or pressure language for WLL/NV. State their position factually in a sentence or two and move on. The only exception is a genuine disaster (e.g. tracking under 30% of target with only days left) — in that case flag it plainly, but still without instruction.

BRAND STRUCTURE:
- TSG (The Sign Group): Core manufacturing. Revenue recognised on job COMPLETION (invoicing), not order placement. Headline TSG figure is INVOICED + WIP DUE THIS MONTH combined — WIP is committed work scheduled to invoice before month-end so it's treated as money in the bank, but it is NOT the same as actual invoiced revenue.
- WLL (WeLoveLEDs): Online LED shop. Invoices at point of order. The WLL figure IS pure invoiced revenue.
- NV (Neon Vibes): Newer division. Invoices at point of order. The NV figure IS pure invoiced revenue.
- Overall/Combined: Sum of TSG (Invoiced + WIP), WLL invoiced, NV invoiced, and any Other.

CRITICAL FIGURE-NAMING RULES (HIGHEST PRIORITY — get this wrong and the update misleads the team):
- The TSG headline figure is NOT "invoiced". Calling it "TSG has invoiced £X" is FACTUALLY INCORRECT when the month is in progress and the figure includes WIP. The reader will think we've banked money we haven't yet.
- For TSG mid-month, use phrasing like: "TSG is sitting at £X for the month (£Y invoiced plus £Z in WIP scheduled to complete)", or "TSG has committed £X — £Y already invoiced with £Z due to invoice before month-end", or "TSG is tracking at £X for May (combined invoiced and dated WIP)".
- Never use the bare word "invoiced" to describe the TSG headline number unless the month is FINAL/CLOSED.
- WLL and NV figures CAN be called "invoiced" at any time.
- "Combined" figures mid-month: "combined position", "combined committed", not "combined invoicing".
- All figures include VAT.

CRITICAL RULES:
- Previous months are CLOSED figures (final). Current month figures are INCOMPLETE until month end.
- For TSG: Do NOT use daily pace maths. Focus on WIP scheduled, order pipeline, and how close the gap is to closing.
- For WLL and NV: Even though daily pace maths are technically valid, AVOID using them in commentary — the team doesn't need pace pressure on e-commerce. Just state the figure and the gap to target.
- Never compare partial current-month totals directly to full previous-month totals without acknowledging the month is incomplete.
- TSG financial year runs Dec-Nov.
- USE THE PROVIDED WORKING-DAY COUNTS. Do not invent "two working days" or "first few days" when the data explicitly tells you how many working days have elapsed. Reference the actual count where useful.

TONE: Direct, factual, no waffle. Plain English. Calm management briefing voice — not motivational, not corporate, not instructive. Use actual numbers. Keep total length to 200-400 words. Short paragraphs. No fluff.

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
1. Brand-by-brand breakdown: TSG, WLL, NV and Overall. For TSG, use the figure-naming rules above — never call its in-progress headline "invoiced". For WLL and NV "invoiced" is fine. Each brand's position against target with actual figures.
2. New sales orders: Total new orders confirmed this month and how that compares to recent months.
3. Sales team performance: List individuals by this month's sales value, highest first. For each: what they won, how that compares to their 6-month average, and any relevant context (absences, patterns). Note meaningful conversion rate differences across the team factually and with the caveat about retrospective confirmation.
4. Trends and growth: Direction of travel vs previous months and same month last year where data exists.
5. Close with the one or two things that will most likely determine how the month finishes (or, for EOM, a brief one-line verdict and what the result sets up for next month — particularly if the user context mentions upcoming challenges).

SECTION HEADINGS in the output:
- Use "BRAND POSITION" or "MONTHLY POSITION" rather than "INVOICED SALES" as the first section heading when the month is in progress (because TSG's figure includes WIP, not just invoiced). Use "INVOICED SALES" only when the month is FINAL/CLOSED.
- "NEW SALES ORDERS" for the second section is fine in all cases.
- "SALES TEAM PERFORMANCE" for the third section is fine.
- "OUTLOOK" for the closing section is fine.`;

    const userPrompt = buildUserPrompt(data, currentMonth, isPartialMonth, periodPosition, monthMeta, userContext, salesTeamData);

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

function buildUserPrompt(data, currentMonth, isPartialMonth, periodPosition, monthMeta, userContext, salesTeamData) {
  const current = data.find(d => d.monthYear === currentMonth);
  const prevMonths = data.filter(d => d.monthYear !== currentMonth).slice(-12);

  function calcOverall(d) {
    return d.overall > 0 ? d.overall : (d.tsg + d.wll + d.nv + (d.other || 0));
  }

  let prompt = `Here are the brand sales figures. Write a concise commentary.\n\n`;

  // ── WORKING-DAY CONTEXT ─────────────────────────────────────────────────────
  // Explicit day counts so the AI doesn't guess. Without this it was saying
  // "two working days in" when we were on day 6 of 20.
  if (monthMeta) {
    if (monthMeta.monthOver) {
      prompt += `## TIMING:\nThe month is complete. ${monthMeta.workingDaysTotal} working days total.\n\n`;
    } else {
      prompt += `## TIMING:\nCurrently on working day ${monthMeta.workingDaysElapsed} of ${monthMeta.workingDaysTotal} for the month. ${monthMeta.workingDaysRemaining} working days remaining. Calendar: day ${monthMeta.calDaysElapsed} of ${monthMeta.calDaysTotal}.\n`;
      prompt += `USE THESE EXACT COUNTS when referencing how far through the month we are. Do NOT invent phrases like "two working days" or "first few days" — the actual count is given.\n\n`;
    }
  }
  // ────────────────────────────────────────────────────────────────────────────

  // ── PERIOD POSITION ─────────────────────────────────────────────────────────
  // Week-based labels matching the dropdown. Each carries appropriate weight
  // of commentary: week 1 minimal, growing through to EOM wrap-up.
  const periodGuidance = {
    'week-1': `PERIOD CONTEXT: Week 1 — the first stretch of working days in the month. Data is sparse. Figures are noise, not signal.

STRICT RULES FOR WEEK 1:
- DO NOT compare current MTD totals to previous full months. "Orders are down 80% vs last month" on day 4 is meaningless.
- DO NOT compare individual sales people to their monthly averages. A handful of days is too small a sample.
- DO NOT project or extrapolate from current figures.
- DO NOT use pace language ("on track", "behind pace", "ahead") for any brand. It is too early.
- TSG invoicing in the first few days reflects whatever happened to complete early — it has no predictive value yet.

WHAT TO WRITE INSTEAD:
- Record what's there as a factual snapshot. Short paragraphs.
- For TSG: surface the WIP scheduled for the month — that's the meaningful number this early. State the gap between (Invoiced + WIP) and target so Ops know what production has to deliver.
- For sales team: note order volume briefly. Don't analyse conversion at this stage.
- For WLL/NV: one sentence each. Just state the figure.
- Close with a brief "watch as the month develops" line — not conclusions.
- Keep it short. There genuinely isn't much to say in Week 1 and that's fine.`,

    'week-2': `PERIOD CONTEXT: Week 2 — second stretch of working days. Data is starting to take shape but is still light. Around 25-50% of the month elapsed.

GUIDANCE FOR WEEK 2:
- Still too early for hard pace conclusions or MoM comparisons.
- TSG is the main subject. State current position (Invoiced + WIP) vs target, what gap remains, and what dated WIP is still due to land.
- For sales team: note order intake building, but don't draw conversion conclusions from small samples yet. Acknowledge individuals' starting positions without ranking them as if the month is decided.
- For WLL/NV: factual one-liner each. Note the position vs target without pace pressure language.
- Avoid any motivational/instructive tone. The teams know what they need to do.
- Keep the focus on what TSG production and TSG sales need to know.`,

    'week-3': `PERIOD CONTEXT: Week 3 — past halfway. Data is now meaningful enough to assess. Around 50-75% of the month elapsed.

GUIDANCE FOR WEEK 3:
- Real assessment is appropriate now. The shape of the month is becoming clear.
- For TSG: state the position (Invoiced + WIP), the gap to target, and what dated WIP is still scheduled. If a closeable or unrealistic gap is becoming visible, say so factually without instruction.
- For TSG sales team: order intake can now be compared to historical averages with appropriate caveats (the conversion-rate-shifts-later caveat still applies). List individuals highest earner first.
- For WLL/NV: factual position only. Note gap to target in one line each. Don't introduce daily pace maths or rallying language.
- This is the right week to flag anything genuinely concerning, but stay factual — no "we need to push harder" instructions.`,

    'week-4': `PERIOD CONTEXT: Week 4 — the final stretch. Most of the month is set. Around 75-100% of working days elapsed.

GUIDANCE FOR WEEK 4:
- The month is largely written. Frame this as where things will land.
- For TSG: clear position now. Invoiced + remaining dated WIP = what we're most likely to close at. State that bluntly with the gap to target.
- For TSG sales team: meaningful order intake comparisons to recent history. Conversion rates becoming more reliable but caveat retrospective confirmation. Highest earner framed as such.
- For WLL/NV: factual closing position. If catastrophically off target (e.g. under 30% with days left) flag it; otherwise state the figure and the gap and move on.
- Close with what the result is setting up for next month — particularly if user context flags anything.`,

    'eom': `PERIOD CONTEXT: End of Month — final, closed figures. The month is complete.

GUIDANCE FOR EOM:
- Write this as a definitive wrap-up. Confident, conclusive tone.
- For TSG: invoiced result vs target. WIP has now invoiced (or didn't) so "TSG invoiced £X" is finally accurate.
- For TSG sales team: full month order intake. Highest earner first, with 6-month context. Conversion rates can now be discussed with the caveat that next month may retrospectively shift some of them.
- For WLL/NV: final invoiced figure vs target. One line each. Brief note on YoY/MoM trend if useful.
- No forward-looking projections needed — just how the month landed.
- Close with a one-line verdict and what the result sets up for next month.`
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
    const tsgInvoicedOnly = Number(current.tsgInvoiced) || 0;
    const tsgWipDated     = Number(current.tsgWip)      || 0;
    // Combined figure that the dashboard exposes for TSG is invoiced + dated
    // WIP. Mid-month this is the "money in the bank" prediction; at month-end
    // WIP will have invoiced and the two converge.
    if (isPartialMonth) {
      prompt += `## CURRENT MONTH POSITION: ${currentMonth} (INCOMPLETE — month still in progress)\n`;
      prompt += `IMPORTANT FIGURE DEFINITIONS — read these carefully and use them correctly in your writing:\n`;
      prompt += `  - TSG headline figure = invoiced revenue + WIP scheduled to invoice this month. Do NOT call this "invoiced". Use phrasing like "TSG is tracking at £X", "TSG has committed £X", "TSG is sitting at £X for the month", or split it: "£Y invoiced plus £Z in dated WIP".\n`;
      prompt += `  - WLL and NV headline figures = pure invoiced revenue (their business model invoices at order). "WLL invoiced £X" is correct.\n`;
      prompt += `  - Combined position = sum of TSG (Inv+WIP) + WLL invoiced + NV invoiced + Other. Describe as "combined position", "combined total for the month", or "tracking combined at £X" — NOT "combined invoicing".\n\n`;

      prompt += `TSG position: £${fmt(current.tsg)} total for the month`;
      if (current.tsgTarget) prompt += ` (Target: £${fmt(current.tsgTarget)}, ${current.tsg >= current.tsgTarget ? 'ABOVE' : 'BELOW'} by £${fmt(Math.abs(current.tsg - current.tsgTarget))})`;
      prompt += `\n  Breakdown: £${fmt(tsgInvoicedOnly)} already invoiced + £${fmt(tsgWipDated)} in WIP scheduled to invoice before month-end\n`;
      if (current.tsgUndated) prompt += `  Additional WIP with no firm due date yet: £${fmt(current.tsgUndated)} (not included in the headline figure)\n`;
      if (current.tsgNextMonth) prompt += `  WIP already dated into next month: £${fmt(current.tsgNextMonth)}\n`;

      prompt += `WLL invoiced: £${fmt(current.wll)}`;
      if (current.wllTarget) prompt += ` (Target: £${fmt(current.wllTarget)}, ${current.wll >= current.wllTarget ? 'ABOVE' : 'BELOW'} by £${fmt(Math.abs(current.wll - current.wllTarget))})`;
      prompt += `\n`;
      prompt += `NV invoiced: £${fmt(current.nv)}`;
      if (current.nvTarget) prompt += ` (Target: £${fmt(current.nvTarget)}, ${current.nv >= current.nvTarget ? 'ABOVE' : 'BELOW'} by £${fmt(Math.abs(current.nv - current.nvTarget))})`;
      prompt += `\n`;
      prompt += `Combined position for the month: £${fmt(overall)}`;
      if (current.overallTarget) prompt += ` (Target: £${fmt(current.overallTarget)})`;
      prompt += `\n\n`;
    } else {
      // Month is final/closed — WIP has invoiced, "invoiced" is now accurate
      // across all brands.
      prompt += `## CURRENT MONTH INVOICED SALES: ${currentMonth} (FINAL FIGURES)\n`;
      prompt += `These are final invoiced figures. Month is closed.\n`;
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
- AUDIENCE: Primary readers are TSG Operations and TSG Sales. Spend most of the words on what those teams need to know — TSG's position and the order intake feeding production. WLL/NV get factual one-liners, not pace coaching.
- FIGURE NAMING: TSG headline figure in an in-progress month is Invoiced + WIP. NEVER call it "TSG has invoiced £X" — that's factually wrong and misleads the team. Use "TSG is tracking at", "TSG has committed", "TSG is sitting at", or split it explicitly into invoiced + WIP. WLL and NV are pure invoiced and can be called "invoiced" freely.
- WORKING DAYS: Use the exact day count provided in the TIMING section above. Don't invent "two working days" or "first few days" — the actual numbers are given.
- TONE: Calm, factual briefing. Not motivational, not instructive. The teams know their roles.
- Keep "MONTHLY POSITION" (in progress) and "NEW SALES ORDERED" clearly separated. They are different things.
- List individuals highest earner first. Frame the top earner as the top earner. Apply the Week 1/2 caveats about sample size where appropriate.
- Use the 6-month history to give context — a good month after a weak run is a recovery, not a benchmark.
- Weave in any user context (absences, retirements, upcoming challenges) naturally where it explains the numbers.
- Apply the period context guidance strictly — especially for Week 1 where MoM and individual comparisons are explicitly banned.`;

  return prompt;
}

function fmt(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-GB');
}
