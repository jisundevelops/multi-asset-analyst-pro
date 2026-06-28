/**
 * Multi-Agent Smart Money AI Analysis Proxy — GROQ-CENTRIC VERSION
 *
 * PROBLEM: OpenRouter free models are in a SHARED pool — all free users
 * share the same rate limit, causing constant 429 errors.
 *
 * SOLUTION: Use Groq as PRIMARY for ALL analysts + Master.
 * Groq gives each user their OWN rate limit (30 req/min on free tier).
 * Different Groq models for each analyst = genuine independence.
 * OpenRouter is fallback only (if Groq is down).
 *
 * Architecture: 4 AI calls per analysis run
 *   3 independent analyst AIs (different Groq models):
 *     - Analyst 1: Groq → llama-3.3-70b-versatile (70B, best reasoning)
 *     - Analyst 2: Groq → deepseek-r1-distill-llama-70b (70B, deep thinking)
 *     - Analyst 3: Groq → llama-3.1-8b-instant (8B, fast second opinion)
 *   1 Master: Groq → llama-3.3-70b-versatile (70B, synthesis)
 *
 *   OpenRouter fallback: If Groq fails entirely, try OpenRouter models.
 *
 * Vercel env vars:
 *   GROQ_API_KEY       — https://console.groq.com/keys (REQUIRED, free, 30 req/min)
 *   OPENROUTER_API_KEY — https://openrouter.ai/keys (OPTIONAL, fallback only)
 *
 * Usage: POST /api/ai-analysis
 *   Body: { snapshot: {...} }
 *   Returns: { analysts: [...], master: {...}, errors: [...] }
 */

// ── Smart Money Prompt ──────────────────────────────────────────
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

// ── Retry wrapper ───────────────────────────────────────────────
async function callWithRetry(fn, maxRetries = 2, baseDelay = 2000) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch(e) {
      lastError = e;
      const is429 = e.message.includes('429');
      const is5xx = e.message.match(/\b5\d\d\b/);
      if (!is429 && !is5xx) throw e;
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.warn(`[AI] Retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${e.message.slice(0, 100)}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

// ── Groq caller ─────────────────────────────────────────────────
async function callGroq(prompt, apiKey, userContent, model, temperature = 0.7) {
  const url = 'https://api.groq.com/openai/v1/chat/completions';
  const body = {
    model,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: userContent },
    ],
    temperature,
    max_tokens: 1500,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) {
    const err = await res.text().catch(()=>'');
    throw new Error(`Groq ${res.status}: ${err.slice(0,200)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

// ── OpenRouter caller (fallback only) ───────────────────────────
async function callOpenRouter(prompt, apiKey, userContent, model) {
  const url = 'https://openrouter.ai/api/v1/chat/completions';
  const body = {
    model,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.7,
    max_tokens: 1500,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://multi-asset-analyst-pro.vercel.app',
      'X-Title': 'Multi-Asset Analyst Pro',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) {
    const err = await res.text().catch(()=>'');
    throw new Error(`OpenRouter ${res.status}: ${err.slice(0,200)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

// ── Smart caller: tries Groq first, then OpenRouter fallback ────
// If orPrimary=true, tries OpenRouter FIRST (for provider diversity)
async function smartCall(prompt, snapshotStr, groqKey, orKey, groqModel, orFallbackModels, temperature = 0.7, orPrimary = false) {
  // If orPrimary, try OpenRouter first
  if (orPrimary && orKey && orFallbackModels && orFallbackModels.length > 0) {
    for (const orModel of orFallbackModels) {
      try {
        console.log(`[AI] Trying OpenRouter (primary): ${orModel}`);
        const text = await callWithRetry(() => callOpenRouter(prompt, orKey, snapshotStr, orModel), 1, 3000);
        return { text, modelUsed: orModel, provider: 'OpenRouter' };
      } catch(orErr) {
        console.warn(`[AI] OpenRouter ${orModel} failed: ${orErr.message.slice(0, 100)}`);
      }
    }
    // OpenRouter failed — fall through to Groq
  }

  // Try Groq (dedicated rate limit, not shared)
  if (groqKey) {
    try {
      const text = await callWithRetry(() => callGroq(prompt, groqKey, snapshotStr, groqModel, temperature));
      return { text, modelUsed: groqModel, provider: 'Groq' };
    } catch(groqErr) {
      console.warn(`[AI] Groq ${groqModel} failed: ${groqErr.message.slice(0, 100)}`);

      // Fallback to OpenRouter if available
      if (orKey && orFallbackModels && orFallbackModels.length > 0) {
        for (const orModel of orFallbackModels) {
          try {
            console.log(`[AI] Trying OpenRouter fallback: ${orModel}`);
            const text = await callWithRetry(() => callOpenRouter(prompt, orKey, snapshotStr, orModel), 1, 3000);
            return { text, modelUsed: orModel, provider: 'OpenRouter' };
          } catch(orErr) {
            console.warn(`[AI] OpenRouter ${orModel} failed: ${orErr.message.slice(0, 100)}`);
          }
        }
      }

      // All failed — throw last Groq error
      throw groqErr;
    }
  }

  // No Groq key — try OpenRouter only
  if (orKey && orFallbackModels && orFallbackModels.length > 0) {
    for (const orModel of orFallbackModels) {
      try {
        console.log(`[AI] Trying OpenRouter (no Groq): ${orModel}`);
        const text = await callWithRetry(() => callOpenRouter(prompt, orKey, snapshotStr, orModel), 1, 3000);
        return { text, modelUsed: orModel, provider: 'OpenRouter' };
      } catch(orErr) {
        console.warn(`[AI] OpenRouter ${orModel} failed: ${orErr.message.slice(0, 100)}`);
      }
    }
  }

  throw new Error('All AI providers failed');
}

// ── JSON extractor ──────────────────────────────────────────────
function extractJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch(_) {}
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

  const snapshotStr = JSON.stringify(snapshot, null, 0);
  const groqKey = process.env.GROQ_API_KEY;
  const orKey = process.env.OPENROUTER_API_KEY;

  if (!groqKey && !orKey) {
    return res.status(503).json({
      error: 'No AI API keys configured. Set GROQ_API_KEY (recommended, free) in Vercel env vars.',
      hint: 'Get free key at https://console.groq.com/keys — Groq gives 30 req/min per user (not shared).',
      analysts: [],
      master: null,
    });
  }

  // ── Analyst configs: Groq primary, OpenRouter fallback ────────
  // Groq decommissions models frequently. Only use CONFIRMED ACTIVE models.
  // As of latest check, ONLY these 2 Groq models are production-stable:
  //   - llama-3.3-70b-versatile (70B)
  //   - llama-3.1-8b-instant (8B)
  // 
  // DECOMMISSIONED (do NOT use): gemma2-9b-it, deepseek-r1-distill-llama-70b,
  //   mixtral-8x7b-32768, llama3-70b-8192, llama3-8b-8192
  //
  // Strategy: Use the 2 stable Groq models for Analysts 1+3,
  // and use OpenRouter (GPT-OSS-120B) as primary for Analyst 2
  // (different provider = genuine independence, no Groq decommission risk).
  // If OpenRouter fails, fall back to Groq Llama-70B with different temp.
  const analysts_config = [
    {
      name: 'Llama-3.3-70B',
      groqModel: 'llama-3.3-70b-versatile',
      groqTemp: 0.7,
      orFallback: ['meta-llama/llama-3.3-70b-instruct:free', 'nvidia/nemotron-3-super-120b-a12b:free'],
    },
    {
      name: 'GPT-OSS-120B',
      groqModel: 'llama-3.3-70b-versatile', // Groq fallback (same model, different temp for variety)
      groqTemp: 0.85,
      orFallback: ['openai/gpt-oss-120b:free', 'nvidia/nemotron-3-super-120b-a12b:free', 'google/gemma-4-31b-it:free'],
      orPrimary: true, // Try OpenRouter FIRST for this analyst
    },
    {
      name: 'Llama-3.1-8B',
      groqModel: 'llama-3.1-8b-instant',
      groqTemp: 0.9,
      orFallback: ['meta-llama/llama-3.2-3b-instruct:free', 'qwen/qwen3-coder:free'],
    },
  ];

  const errors = [];

  // ── Phase 1: Call all 3 analysts in parallel ──────────────────
  const analystPromises = analysts_config.map(async (provider) => {
    try {
      const result = await smartCall(
        ANALYST_PROMPT, snapshotStr, groqKey, orKey,
        provider.groqModel, provider.orFallback, provider.groqTemp || 0.7, provider.orPrimary || false
      );
      const parsed = extractJSON(result.text);
      return {
        provider: provider.name,
        model: result.modelUsed,
        verdict: parsed?.verdict || 'UNKNOWN',
        confidence: parsed?.confidence || 0,
        retailView: parsed?.retailView || 'N/A',
        trapDetected: parsed?.trapDetected || false,
        trapType: parsed?.trapType || null,
        smartEntry: parsed?.smartEntry || 'N/A',
        reasoning: parsed?.reasoning || result.text.slice(0, 500),
      };
    } catch(e) {
      errors.push({ provider: provider.name, error: e.message });
      return {
        provider: provider.name,
        model: provider.groqModel,
        verdict: 'ERROR',
        confidence: 0,
        reasoning: `API call failed: ${e.message}`,
        error: true,
      };
    }
  });

  const analysts = await Promise.all(analystPromises);
  const validAnalysts = analysts.filter(a => !a.error);

  // ── Phase 2: Master AI ────────────────────────────────────────
  let master = null;

  if (validAnalysts.length >= 2) {
    try {
      const masterInput = JSON.stringify(validAnalysts.map(a => ({
        provider: a.provider,
        model: a.model,
        verdict: a.verdict,
        confidence: a.confidence,
        trapDetected: a.trapDetected,
        trapType: a.trapType,
        reasoning: a.reasoning,
      })), null, 2);

      // Master uses Groq Llama-70B (most capable Groq model)
      // OpenRouter fallback: GPT-OSS-120B → Nemotron-120B → Qwen3-Coder
      const masterResult = await smartCall(
        MASTER_PROMPT, masterInput, groqKey, orKey,
        'llama-3.3-70b-versatile',
        ['openai/gpt-oss-120b:free', 'nvidia/nemotron-3-super-120b-a12b:free', 'qwen/qwen3-coder:free']
      );
      const parsed = extractJSON(masterResult.text);
      master = {
        verdict: parsed?.verdict || 'WAIT',
        confidence: parsed?.confidence || 0,
        consensus: parsed?.consensus || 'unknown',
        finalReasoning: parsed?.finalReasoning || 'Master analysis unavailable',
        keyInsight: parsed?.keyInsight || 'N/A',
        riskWarning: parsed?.riskWarning || 'N/A',
        optimalEntry: parsed?.optimalEntry || 'N/A',
        positionAdvice: parsed?.positionAdvice || 'N/A',
        masterModel: masterResult.modelUsed,
      };
    } catch(e) {
      errors.push({ provider: 'Master AI', error: e.message });
      master = computeFallbackMaster(validAnalysts);
    }
  } else if (validAnalysts.length === 1) {
    master = {
      verdict: validAnalysts[0].verdict,
      confidence: validAnalysts[0].confidence,
      consensus: 'single-analyst',
      finalReasoning: 'Only 1 AI analyst succeeded. Verdict from ' + validAnalysts[0].provider + '.',
      keyInsight: validAnalysts[0].reasoning,
      riskWarning: 'Limited analysis — only 1 AI succeeded.',
      optimalEntry: validAnalysts[0].smartEntry,
      positionAdvice: 'Reduce position size — limited consensus.',
      masterModel: 'fallback-single',
    };
  } else {
    master = computeFallbackMaster(validAnalysts);
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ analysts, master, errors, timestamp: new Date().toISOString() });
}

// ── Fallback master consensus ───────────────────────────────────
function computeFallbackMaster(analysts) {
  if (!analysts || analysts.length === 0) {
    return {
      verdict: 'WAIT', confidence: 0, consensus: 'no-data',
      finalReasoning: 'No valid analyst results available.',
      keyInsight: 'All AI providers failed. Check API keys and try again.',
      riskWarning: 'Cannot assess risk without AI analysis.',
      optimalEntry: 'N/A',
      positionAdvice: 'Do not trade without AI analysis.',
      masterModel: 'fallback-no-data',
    };
  }
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

  if (trapCount > 0 && verdict === 'TAKE TRADE') {
    verdict = 'WAIT'; consensus = 'trap-detected';
  }

  return {
    verdict, confidence: avgConf, consensus,
    finalReasoning: `Computed consensus from ${analysts.length} analysts. ${takeCount} TAKE, ${skipCount} SKIP, ${waitCount} WAIT. ${trapCount} trap(s) detected.`,
    keyInsight: trapCount > 0 ? 'Trap detected — exercise caution.' : 'No traps detected.',
    riskWarning: trapCount > 0 ? 'Potential retail trap in progress.' : 'Standard risk applies.',
    optimalEntry: 'See individual analyst recommendations.',
    positionAdvice: verdict === 'TAKE TRADE' ? 'Standard position size.' : 'Reduce or skip.',
    masterModel: 'fallback-consensus',
  };
}
