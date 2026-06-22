/**
 * TwelveData API Proxy
 * Hides API keys from frontend — keys stored in Vercel environment variables
 *
 * Usage: /api/td?_ep=time_series&symbol=BTC/USD&interval=1min&...
 *
 * Vercel env vars needed:
 *   TD_KEY_1 through TD_KEY_10
 */

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  // Extract endpoint (_ep) and remaining params
  const { _ep, ...params } = req.query;

  if (!_ep) {
    return res.status(400).json({ status: 'error', message: 'Missing _ep parameter' });
  }

  // Always strip any client-provided apikey (security)
  delete params.apikey;

  // Collect keys from environment variables (TD_KEY_1 … TD_KEY_10)
  const keys = [];
  for (let i = 1; i <= 10; i++) {
    const k = process.env[`TD_KEY_${i}`];
    if (k && k.trim()) keys.push(k.trim());
  }

  if (!keys.length) {
    console.error('[td-proxy] No API keys configured in environment');
    return res.status(503).json({ status: 'error', message: 'Service temporarily unavailable' });
  }

  // Stateless round-robin: rotate key every minute
  const keyIndex = Math.floor(Date.now() / 60000) % keys.length;
  const apiKey   = keys[keyIndex];

  // Build upstream URL
  const qs          = new URLSearchParams({ ...params, apikey: apiKey }).toString();
  const upstreamUrl = `https://api.twelvedata.com/${_ep}?${qs}`;

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: { 'User-Agent': 'BTC-Analyst-Pro/4.0' },
      signal: AbortSignal.timeout(12000),
    });

    const data = await upstream.json();

    // Short cache for time-series, no cache for price/quote
    if (_ep === 'time_series') {
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }

    return res.status(upstream.status).json(data);
  } catch (e) {
    console.error('[td-proxy] Upstream error:', e.message);
    return res.status(502).json({ status: 'error', message: 'Upstream request failed' });
  }
}
