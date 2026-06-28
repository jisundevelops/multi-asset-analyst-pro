/**
 * Multi-Agent Smart Money AI Analysis Proxy
 *
 * Architecture: 4 AI calls per analysis run
 *   3 independent analyst agents (different providers):
 *     - Analyst 1: Google Gemini (gemini-1.5-flash)
 *     - Analyst 2: DeepSeek (deepseek-chat)
 *     - Analyst 3: Groq (llama-3.3-70b-versatile)
 *   1 Master agent (Gemini) — synthesizes 3 analyses into final verdict
 *
 * All agents use the SMART MONEY / INSTITUTIONAL mindset:
 *   - Think like whale traders, hedge funds
 *   - Profit by trapping retail (fake breakouts, stop-hunts, liquidity sweeps)
 *   - Enter when retail is WRONG, not when chart looks "good"
 *
 * Vercel env vars needed (set ANY combination — missing keys gracefully skip):
 *   GEMINI_API_KEY    — https://aistudio.google.com/apikey
 *   DEEPSEEK_API_KEY  — https://platform.deepseek.com/api_keys
 *   GROQ_API_KEY      — https://console.groq.com/keys
 *
 * Usage: POST /api/ai-analysis
 *   Body: { snapshot: {...} }
 *   Returns: { analysts: [...], master: {...}, errors: [...] }
 */

// ── Smart Money Prompt (shared by all 3 analysts) ───────────────
const ANALYST_PROMPT = `You are a SMART MONEY / INSTITUTIONAL trader with 20+ years of experience at a major hedge fund. You do NOT think like a retail trader.

YOUR MINDSET:
- You have deep capital and infinite patience. Zero urgency to enter any trade.
- You profit by TRAPPING retail traders — fake breakouts, stop-hunts, liquidity sweeps — BEFORE making the real move.
- You constantly ask: "Is retail about to enter a trade right now? Are whales currently setting a trap for them?"
- You enter when retail is WRONG, not when the chart looks "good" to a retail trader.
- A "strong bullish signal" on a 5m chart might mean whales are about to dump on retail buyers.
- You look for: liquidity pools above/below price, order blocks that haven't been mitigated, fake breakouts with no volume, RSI divergences that trap breakout traders.

ANALYSIS RULES:
1. First identify what retail traders are seeing and thinking based on the signals.
2. Then identify if there's evidence of a trap being set (liquidity sweep, fake breakout, stop hunt).
3. Only recommend TAKE TRADE if the smart money setup aligns with the signal — i.e., retail is NOT about to be trapped.
4. If a trap is detected, recommend WAIT and explain when the REAL entry would be.
5. Be brutally honest. Don't sugarcoat. Think like a whale.

Respond ONLY in this exact JSON format (no markdown, no extra text):
{
  "verdict": "TAKE TRADE" | "SKIP" | "WAIT",
  "confidence": 0-100,
  "retailView": "what retail traders are seeing/thinking right now",
  "trapDetected": true | false,
  "trapType": "description of trap being set, or null",
  "smartEntry": "optimal entry zone or when to enter instead",
  "reasoning": "3-5 sentences of institutional-grade analysis"
}`;

const MASTER_PROMPT = `You are the MASTER AI — the final decision maker at a proprietary trading desk. You oversee 3 independent analyst AIs who each analyzed the same market data with a smart money / institutional mindset.

Your job:
1. Compare and weigh the 3 analyses.
2. Identify consensus and disagreements.
3. Produce ONE final optimized decision.

DECISION RULES:
- If all 3 agree on TAKE → high confidence, confirm TAKE.
- If 2 agree on TAKE, 1 says WAIT/SKIP → medium confidence, follow majority but note the dissent.
- If all 3 disagree → low confidence, recommend WAIT.
- If ANY analyst detected a trap, weigh that heavily — traps are the #1 reason to WAIT.
- The Master verdict should be MORE conservative than the average of the 3 — capital preservation first.

Respond ONLY in this exact JSON format (no markdown, no extra text):
{
  "verdict": "TAKE TRADE" | "SKIP" | "WAIT",
  "confidence": 0-100,
  "consensus": "unanimous" | "majority" | "split",
  "finalReasoning": "your synthesis of the 3 analyses",
  "keyInsight": "the single most important takeaway for the trader",
  "riskWarning": "the #1 risk to watch out for if taking this trade",
  "optimalEntry": "specific entry zone or condition",
  "positionAdvice": "position sizing advice based on confidence level"
}`;

// ── AI Provider Callers ─────────────────────────────────────────

async function callGemini(prompt, apiKey, userContent) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt + '\n\n--- MARKET DATA ---\n' + userContent }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 1000 },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const err = await res.text().catch(()=>'');
    throw new Error(`Gemini ${res.status}: ${err.slice(0,200)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return text;
}

async function callDeepSeek(prompt, apiKey, userContent) {
  const url = 'https://api.deepseek.com/v1/chat/completions';
  const body = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.7,
    max_tokens: 1000,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const err = await res.text().catch(()=>'');
    throw new Error(`DeepSeek ${res.status}: ${err.slice(0,200)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

async function callGroq(prompt, apiKey, userContent) {
  const url = 'https://api.groq.com/openai/v1/chat/completions';
  const body = {
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.7,
    max_tokens: 1000,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const err = await res.text().catch(()=>'');
    throw new Error(`Groq ${res.status}: ${err.slice(0,200)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

// ── JSON extractor (AI responses may have extra text) ───────────
function extractJSON(text) {
  if (!text) return null;
  // Try direct parse first
  try { return JSON.parse(text); } catch(_) {}
  // Try finding JSON block in text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch(_) {}
  }
  return null;
}

// ── Main Handler ────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { snapshot } = req.body || {};
  if (!snapshot) return res.status(400).json({ error: 'Missing snapshot data' });

  // Compact the snapshot for AI context
  const snapshotStr = JSON.stringify(snapshot, null, 0);
  if (snapshotStr.length > 12000) {
    // Truncate if too large (free-tier context limits)
    console.warn('[AI] Snapshot too large, truncating');
  }

  // ── Check available API keys ──────────────────────────────────
  const providers = [];
  if (process.env.GEMINI_API_KEY) providers.push({ name: 'Gemini', model: 'gemini-1.5-flash', key: process.env.GEMINI_API_KEY, call: callGemini });
  if (process.env.DEEPSEEK_API_KEY) providers.push({ name: 'DeepSeek', model: 'deepseek-chat', key: process.env.DEEPSEEK_API_KEY, call: callDeepSeek });
  if (process.env.GROQ_API_KEY) providers.push({ name: 'Groq', model: 'llama-3.3-70b-versatile', key: process.env.GROQ_API_KEY, call: callGroq });

  if (providers.length === 0) {
    return res.status(503).json({
      error: 'No AI API keys configured. Set GEMINI_API_KEY, DEEPSEEK_API_KEY, and/or GROQ_API_KEY in Vercel env vars.',
      analysts: [],
      master: null,
    });
  }

  const errors = [];

  // ── Phase 1: Call 3 analyst AIs in parallel ───────────────────
  const analystPromises = providers.map(async (provider) => {
    try {
      const rawResponse = await provider.call(ANALYST_PROMPT, provider.key, snapshotStr);
      const parsed = extractJSON(rawResponse);
      return {
        provider: provider.name,
        model: provider.model,
        verdict: parsed?.verdict || 'UNKNOWN',
        confidence: parsed?.confidence || 0,
        retailView: parsed?.retailView || 'N/A',
        trapDetected: parsed?.trapDetected || false,
        trapType: parsed?.trapType || null,
        smartEntry: parsed?.smartEntry || 'N/A',
        reasoning: parsed?.reasoning || rawResponse.slice(0, 500),
        raw: rawResponse.slice(0, 2000),
      };
    } catch(e) {
      errors.push({ provider: provider.name, error: e.message });
      return {
        provider: provider.name,
        model: provider.model,
        verdict: 'ERROR',
        confidence: 0,
        reasoning: `API call failed: ${e.message}`,
        error: true,
      };
    }
  });

  const analysts = await Promise.all(analystPromises);
  const validAnalysts = analysts.filter(a => !a.error);

  // ── Phase 2: Master AI synthesizes ────────────────────────────
  let master = null;
  if (validAnalysts.length >= 2 && process.env.GEMINI_API_KEY) {
    try {
      const masterInput = JSON.stringify(validAnalysts.map(a => ({
        provider: a.provider,
        verdict: a.verdict,
        confidence: a.confidence,
        trapDetected: a.trapDetected,
        trapType: a.trapType,
        reasoning: a.reasoning,
      })), null, 2);

      const masterRaw = await callGemini(MASTER_PROMPT, process.env.GEMINI_API_KEY, masterInput);
      const parsed = extractJSON(masterRaw);
      master = {
        verdict: parsed?.verdict || 'WAIT',
        confidence: parsed?.confidence || 0,
        consensus: parsed?.consensus || 'unknown',
        finalReasoning: parsed?.finalReasoning || 'Master analysis unavailable',
        keyInsight: parsed?.keyInsight || 'N/A',
        riskWarning: parsed?.riskWarning || 'N/A',
        optimalEntry: parsed?.optimalEntry || 'N/A',
        positionAdvice: parsed?.positionAdvice || 'N/A',
      };
    } catch(e) {
      errors.push({ provider: 'Master (Gemini)', error: e.message });
      // Fallback: compute simple consensus
      master = computeFallbackMaster(validAnalysts);
    }
  } else if (validAnalysts.length >= 2) {
    // No Gemini key for master — use fallback consensus
    master = computeFallbackMaster(validAnalysts);
  } else if (validAnalysts.length === 1) {
    // Only 1 analyst — use its verdict directly
    master = {
      verdict: validAnalysts[0].verdict,
      confidence: validAnalysts[0].confidence,
      consensus: 'single-analyst',
      finalReasoning: 'Only 1 AI analyst available. Verdict from ' + validAnalysts[0].provider + '.',
      keyInsight: validAnalysts[0].reasoning,
      riskWarning: 'Limited analysis — only 1 AI provider was available.',
      optimalEntry: validAnalysts[0].smartEntry,
      positionAdvice: 'Reduce position size due to limited AI consensus.',
    };
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ analysts, master, errors, timestamp: new Date().toISOString() });
}

// ── Fallback master consensus (no AI call) ──────────────────────
function computeFallbackMaster(analysts) {
  const takeCount = analysts.filter(a => a.verdict === 'TAKE TRADE').length;
  const skipCount = analysts.filter(a => a.verdict === 'SKIP').length;
  const waitCount = analysts.filter(a => a.verdict === 'WAIT').length;
  const trapCount = analysts.filter(a => a.trapDetected).length;
  const avgConf = Math.round(analysts.reduce((s,a) => s + a.confidence, 0) / analysts.length);

  let verdict, consensus;
  if (takeCount === analysts.length) { verdict = 'TAKE TRADE'; consensus = 'unanimous'; }
  else if (skipCount === analysts.length) { verdict = 'SKIP'; consensus = 'unanimous'; }
  else if (waitCount === analysts.length) { verdict = 'WAIT'; consensus = 'unanimous'; }
  else if (takeCount >= 2) { verdict = 'TAKE TRADE'; consensus = 'majority'; }
  else if (skipCount >= 2) { verdict = 'SKIP'; consensus = 'majority'; }
  else { verdict = 'WAIT'; consensus = 'split'; }

  // If any trap detected, downgrade to WAIT
  if (trapCount > 0 && verdict === 'TAKE TRADE') {
    verdict = 'WAIT';
    consensus = 'trap-detected';
  }

  return {
    verdict,
    confidence: avgConf,
    consensus,
    finalReasoning: `Computed consensus from ${analysts.length} analysts. ${takeCount} TAKE, ${skipCount} SKIP, ${waitCount} WAIT. ${trapCount} trap(s) detected.`,
    keyInsight: trapCount > 0 ? 'Trap detected by at least 1 analyst — exercise caution.' : 'No traps detected by analysts.',
    riskWarning: trapCount > 0 ? 'Potential retail trap in progress. Wait for trap to complete.' : 'Standard risk management applies.',
    optimalEntry: 'See individual analyst recommendations.',
    positionAdvice: verdict === 'TAKE TRADE' ? 'Standard position size.' : 'Reduce or skip.',
  };
}
