/**
 * Finnhub API Proxy
 * Hides the Finnhub API key from frontend — key stored in Vercel env var.
 *
 * Mirrors the pattern of api/td.js (Twelve Data proxy).
 *
 * Usage: /api/macro?symbol=VIX
 * Returns: { price, prevClose, change, changePct, high, low }
 *
 * Vercel env var needed:
 *   FINNHUB_KEY  — your Finnhub API token
 */

// In-memory cache for Finnhub quotes.
// Quote data changes infrequently (once per minute on Finnhub free tier),
// so a 60-second TTL cuts ~95% of upstream calls and prevents abuse.
const _macroCache = new Map();
const MACRO_CACHE_TTL_MS = 60 * 1000;

export default async function handler(req, res) {
  // CORS — same policy as api/td.js
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const { symbol } = req.query;

  if (!symbol || typeof symbol !== 'string') {
    return res.status(400).json({ status: 'error', message: 'Missing symbol parameter' });
  }

  // Reject suspiciously long symbols (mitigate injection attempts)
  if (symbol.length > 32) {
    return res.status(400).json({ status: 'error', message: 'Invalid symbol' });
  }

  const apiKey = process.env.FINNHUB_KEY;
  if (!apiKey || !apiKey.trim()) {
    console.error('[macro-proxy] No FINNHUB_KEY configured in environment');
    return res.status(503).json({ status: 'error', message: 'Service temporarily unavailable' });
  }

  // Cache hit?
  const cacheKey = symbol.toUpperCase();
  const cached = _macroCache.get(cacheKey);
  const now = Date.now();
  if (cached && (now - cached.ts) < MACRO_CACHE_TTL_MS) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Macro-Cache', 'HIT');
    return res.status(200).json(cached.data);
  }

  // Build upstream URL — never expose the key to the client.
  const upstreamUrl = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`;

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: { 'User-Agent': 'BTC-Analyst-Pro/4.0' },
      signal: AbortSignal.timeout(8000),
    });

    const data = await upstream.json();

    // Finnhub returns 200 with `{ c: 0, h: 0, l: 0, ... }` for invalid symbols
    // or before market open. Normalize to the shape fetchFinnhubQuote expects.
    // Also strip any error fields so client gets a consistent shape.
    const normalized = {
      price:      typeof data.c === 'number' ? data.c : 0,
      prevClose:  typeof data.pc === 'number' ? data.pc : 0,
      change:     typeof data.d === 'number' ? data.d : 0,
      changePct:  typeof data.dp === 'number' ? data.dp : 0,
      high:       typeof data.h === 'number' ? data.h : 0,
      low:        typeof data.l === 'number' ? data.l : 0,
      // Finnhub returns these as strings — pass through for debugging only.
      o:          data.o,  // open
      t:          data.t,  // timestamp of last update
    };

    // Cache only valid responses (price > 0)
    if (normalized.price > 0) {
      _macroCache.set(cacheKey, { data: normalized, ts: now });
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Macro-Cache', 'MISS');
    return res.status(200).json(normalized);
  } catch (e) {
    console.error('[macro-proxy] Upstream error:', e.message);
    return res.status(502).json({ status: 'error', message: 'Upstream request failed' });
  }
}
