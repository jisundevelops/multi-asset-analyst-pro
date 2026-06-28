/**
 * Multi-Agent Smart Money AI Analysis Proxy — UPGRADED MODELS
 *
 * Architecture: 4 AI calls per analysis run
 *   3 independent analyst AIs (different providers + models):
 *     - Analyst 1: Groq → llama-3.3-70b-versatile (fast, 70B params)
 *     - Analyst 2: DeepSeek → deepseek-chat (V3, 671B MoE, deep reasoning)
 *     - Analyst 3: OpenRouter → qwen3-next-80b-a3b-instruct (80B, FREE!)
 *   1 Master agent: OpenRouter → Hermes-3-Llama-405B (405B params! FREE!)
 *     — Most powerful FREE model available (405B > Gemini Flash ~27B)
 *     — 131K context, excellent at reasoning and synthesis
 *
 * FALLBACK: If OpenRouter key is set but Groq/DeepSeek aren't,
 *   OpenRouter is used for ALL 3 analysts with different models:
 *     - meta-llama/llama-3.3-70b-instruct:free
 *     - deepseek/deepseek-chat (if available)
 *     - qwen/qwen3-next-80b-a3b-instruct:free
 *   This means the system works with JUST 1 API key (OpenRouter)!
 *
 * Vercel env vars (set ANY combination — all have free tiers):
 *   GROQ_API_KEY       — https://console.groq.com/keys
 *   DEEPSEEK_API_KEY   — https://platform.deepseek.com/api_keys
 *   OPENROUTER_API_KEY — https://openrouter.ai/keys (gives free credits)
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

async function callGemini(prompt, apiKey, userContent, model = 'gemini-2.0-flash') {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt + '\n\n--- MARKET DATA ---\n' + userContent }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 1500 },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) {
    const err = await res.text().catch(()=>'');
    throw new Error(`Gemini ${res.status}: ${err.slice(0,200)}`);
  }
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callDeepSeek(prompt, apiKey, userContent, model = 'deepseek-chat') {
  const url = 'https://api.deepseek.com/v1/chat/completions';
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
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) {
    const err = await res.text().catch(()=>'');
    throw new Error(`DeepSeek ${res.status}: ${err.slice(0,200)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

async function callGroq(prompt, apiKey, userContent, model = 'llama-3.3-70b-versatile') {
  const url = 'https://api.groq.com/openai/v1/chat/completions';
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

// ── OpenRouter caller (supports many models, including FREE Qwen3) ──
async function callOpenRouter(prompt, apiKey, userContent, model = 'qwen/qwen3-next-80b-a3b-instruct:free') {
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

// ── JSON extractor (AI responses may have extra text) ───────────
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

  // ── Build analyst list based on available API keys ────────────
  // Priority: use dedicated providers first, fall back to OpenRouter
  const analysts_config = [];

  // Analyst 1: Groq → Llama 3.3 70B
  if (process.env.GROQ_API_KEY) {
    analysts_config.push({
      name: 'Groq-Llama',
      model: 'llama-3.3-70b-versatile',
      key: process.env.GROQ_API_KEY,
      call: callGroq,
    });
  } else if (process.env.OPENROUTER_API_KEY) {
    // Fallback: use OpenRouter's free Llama
    analysts_config.push({
      name: 'OpenRouter-Llama',
      model: 'meta-llama/llama-3.3-70b-instruct:free',
      key: process.env.OPENROUTER_API_KEY,
      call: callOpenRouter,
    });
  }

  // Analyst 2: DeepSeek → deepseek-chat (V3, 671B MoE)
  if (process.env.DEEPSEEK_API_KEY) {
    analysts_config.push({
      name: 'DeepSeek',
      model: 'deepseek-chat',
      key: process.env.DEEPSEEK_API_KEY,
      call: callDeepSeek,
    });
  } else if (process.env.OPENROUTER_API_KEY) {
    // Fallback: use OpenRouter's GPT-OSS 120B (free, powerful)
    analysts_config.push({
      name: 'OpenRouter-GPT-OSS',
      model: 'openai/gpt-oss-120b:free',
      key: process.env.OPENROUTER_API_KEY,
      call: callOpenRouter,
    });
  }

  // Analyst 3: OpenRouter → Qwen3 80B (FREE!) or Qwen3 32B (paid)
  if (process.env.OPENROUTER_API_KEY) {
    analysts_config.push({
      name: 'OpenRouter-Qwen3',
      model: 'qwen/qwen3-next-80b-a3b-instruct:free', // 80B params, FREE, 262K context
      key: process.env.OPENROUTER_API_KEY,
      call: callOpenRouter,
    });
  }

  // Analyst 4 (bonus): NVIDIA Nemotron 120B if we need more analysts
  if (analysts_config.length < 3 && process.env.OPENROUTER_API_KEY) {
    analysts_config.push({
      name: 'OpenRouter-Nemotron',
      model: 'nvidia/nemotron-3-super-120b-a12b:free', // 120B, 1M context, FREE
      key: process.env.OPENROUTER_API_KEY,
      call: callOpenRouter,
    });
  }

  if (analysts_config.length === 0) {
    return res.status(503).json({
      error: 'No AI API keys configured. Set at least OPENROUTER_API_KEY (recommended, free) in Vercel env vars.',
      hint: 'OpenRouter is recommended — 1 key gives access to Qwen3, Llama, GPT-OSS and more for FREE.',
      analysts: [],
      master: null,
    });
  }

  const errors = [];

  // ── Phase 1: Call all analyst AIs in parallel ─────────────────
  const analystPromises = analysts_config.map(async (provider) => {
    try {
      const rawResponse = await provider.call(ANALYST_PROMPT, provider.key, snapshotStr, provider.model);
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

  // ── Master AI: Hermes-3-Llama-405B (405B params, FREE on OpenRouter) ──
  // Most powerful free model available — far exceeds Gemini Flash in reasoning.
  // 131K context is plenty for 3 analyst outputs.
  // Fallback chain: Hermes-405B → GPT-OSS-120B → Qwen3-Coder → fallback consensus
  if (validAnalysts.length >= 2 && process.env.OPENROUTER_API_KEY) {
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

      // Try Hermes-3 405B first (most powerful free model)
      let masterRaw;
      try {
        masterRaw = await callOpenRouter(MASTER_PROMPT, process.env.OPENROUTER_API_KEY, masterInput, 'nousresearch/hermes-3-llama-3.1-405b:free');
      } catch(e1) {
        // Fallback: GPT-OSS 120B (second most powerful free)
        try {
          masterRaw = await callOpenRouter(MASTER_PROMPT, process.env.OPENROUTER_API_KEY, masterInput, 'openai/gpt-oss-120b:free');
        } catch(e2) {
          // Fallback: Qwen3-Coder (1M context)
          masterRaw = await callOpenRouter(MASTER_PROMPT, process.env.OPENROUTER_API_KEY, masterInput, 'qwen/qwen3-coder:free');
        }
      }
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
        masterModel: 'Hermes-3-Llama-405B (OpenRouter)',
      };
    } catch(e) {
      errors.push({ provider: 'Master (OpenRouter)', error: e.message });
      master = computeFallbackMaster(validAnalysts);
    }
  } else if (validAnalysts.length === 1) {
    master = {
      verdict: validAnalysts[0].verdict,
      confidence: validAnalysts[0].confidence,
      consensus: 'single-analyst',
      finalReasoning: 'Only 1 AI analyst available. Verdict from ' + validAnalysts[0].provider + '.',
      keyInsight: validAnalysts[0].reasoning,
      riskWarning: 'Limited analysis — only 1 AI provider was available.',
      optimalEntry: validAnalysts[0].smartEntry,
      positionAdvice: 'Reduce position size due to limited AI consensus.',
      masterModel: 'fallback-single',
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
    masterModel: 'fallback-consensus',
  };
}
