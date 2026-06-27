/**
 * Macro Data Proxy — server-side fetcher for VIX, DXY, US10Y, US2Y.
 *
 * WHY THIS EXISTS:
 *   - Finnhub free tier does NOT support indices (VIX, DXY, US10Y, US2Y).
 *     All these symbols return {price:0} → useless.
 *   - Twelve Data free tier also does NOT support them (returns 404 with
 *     "available starting with the Grow or Venture plan").
 *   - Yahoo Finance's chart API DOES support them and is free, but only
 *     works server-side with a proper User-Agent header (browser requests
 *     get CORS-blocked, and requests without a UA get rate-limited).
 *
 * SOLUTION:
 *   This proxy fetches from Yahoo Finance's `query2.finance.yahoo.com`
 *   endpoint server-side, normalizes the response to the shape the client
 *   expects ({price, prevClose, change, changePct, high, low}), and adds
 *   a 60-second in-memory cache to cut upstream load.
 *
 * Usage: /api/macro?symbol=VIX
 *        /api/macro?symbol=DXY
 *        /api/macro?symbol=US10Y
 *        /api/macro?symbol=US2Y
 *        /api/macro?symbol=US2YR   (alias for US2Y)
 *
 * Returns: { price, prevClose, change, changePct, high, low, source }
 */

// Map our friendly symbol names to Yahoo Finance ticker symbols.
// Yahoo uses ^-prefixed tickers for CBOE indices (VIX, TNX, IRX, FVX)
// and special codes for ICE indices (DX-Y.NYB for DXY).
const YAHOO_SYMBOL_MAP = {
  // Volatility
  VIX:        '^VIX',       // CBOE Volatility Index
  // Dollar Index
  DXY:        'DX-Y.NYB',   // ICE US Dollar Index
  DXUSD:      'DX-Y.NYB',   // alias
  // Treasury yields (CBOE symbols)
  US10Y:      '^TNX',       // 10-Year Treasury Yield (CBOE)
  US2Y:       '^IRX',       // 13-week (used as 2Y proxy since CBOE 2Y is rarely supported)
  US2YR:      '^IRX',       // alias
  US5Y:       '^FVX',       // 5-Year Treasury Yield
  US30Y:      '^TYX',       // 30-Year Treasury Yield
};

// In-memory cache — quote data changes infrequently and we want to be nice
// to Yahoo's free API. 60s TTL matches the client-side cache.
const _macroCache = new Map();
const MACRO_CACHE_TTL_MS = 60 * 1000;

// Vercel module-level state survives across warm lambda invocations.
// On cold start it's fresh. Each warm lambda has its own cache.

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
  if (symbol.length > 32) {
    return res.status(400).json({ status: 'error', message: 'Invalid symbol' });
  }

  const upperSymbol = symbol.toUpperCase();
  const yahooSymbol = YAHOO_SYMBOL_MAP[upperSymbol];

  if (!yahooSymbol) {
    return res.status(400).json({
      status: 'error',
      message: `Unsupported symbol: ${upperSymbol}. Supported: ${Object.keys(YAHOO_SYMBOL_MAP).join(', ')}`,
    });
  }

  // Cache hit?
  const cached = _macroCache.get(upperSymbol);
  const now = Date.now();
  if (cached && (now - cached.ts) < MACRO_CACHE_TTL_MS) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Macro-Cache', 'HIT');
    return res.status(200).json(cached.data);
  }

  // Yahoo Finance chart API — server-side fetch with browser-like User-Agent.
  // The chart endpoint returns historical OHLC + meta with current price.
  // We use range=5d (5 days) to ensure we get at least 2 trading days for
  // prevClose calculation (weekends, holidays).
  const yahooUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=5d`;

  try {
    const upstream = await fetch(yahooUrl, {
      headers: {
        // Yahoo blocks requests without a User-Agent. A real browser UA works.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!upstream.ok) {
      console.error(`[macro-proxy] Yahoo returned HTTP ${upstream.status} for ${yahooSymbol}`);
      // Return a structured error so client can show "unavailable" rather than crashing
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Macro-Cache', 'MISS-ERROR');
      return res.status(502).json({
        status: 'error',
        message: `Yahoo Finance returned HTTP ${upstream.status}`,
        price: 0, prevClose: 0, change: 0, changePct: 0, high: 0, low: 0,
        source: 'yahoo-error',
      });
    }

    const data = await upstream.json();

    // Yahoo response shape:
    //   { chart: { result: [{ meta: {...}, timestamp: [...], indicators: {...} }], error: null } }
    if (!data?.chart?.result || !Array.isArray(data.chart.result) || data.chart.result.length === 0) {
      console.error(`[macro-proxy] Yahoo returned no result for ${yahooSymbol}:`, JSON.stringify(data).slice(0, 200));
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({
        status: 'error',
        message: 'Yahoo Finance returned no data',
        price: 0, prevClose: 0, change: 0, changePct: 0, high: 0, low: 0,
        source: 'yahoo-empty',
      });
    }

    const meta = data.chart.result[0].meta || {};
    const price = typeof meta.regularMarketPrice === 'number' ? meta.regularMarketPrice : 0;
    // chartPreviousClose is the close of the day before the range start —
    // for range=5d that's ~5 trading days ago, which isn't what we want.
    // We want the previous TRADING DAY's close. Yahoo provides this as
    // `chartPreviousClose` for short ranges, but for accuracy we use the
    // second-to-last close from the indicators.candles data if available.
    let prevClose = typeof meta.chartPreviousClose === 'number' ? meta.chartPreviousClose : price;

    const candles = data.chart.result[0].indicators?.quote?.[0];
    if (candles?.close && Array.isArray(candles.close)) {
      // Find the last non-null close that isn't the most recent
      const closes = candles.close.filter(c => c != null);
      if (closes.length >= 2) {
        prevClose = closes[closes.length - 2];
      }
    }

    const change = price - prevClose;
    const changePct = prevClose > 0 ? (change / prevClose * 100) : 0;
    const high = typeof meta.regularMarketDayHigh === 'number' && meta.regularMarketDayHigh > 0
                 ? meta.regularMarketDayHigh : price;
    const low  = typeof meta.regularMarketDayLow  === 'number' && meta.regularMarketDayLow  > 0
                 ? meta.regularMarketDayLow  : price;

    // Sanity check — if price is 0 or NaN, the data is bad
    if (!isFinite(price) || price <= 0) {
      console.error(`[macro-proxy] Yahoo returned invalid price for ${yahooSymbol}:`, price);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({
        status: 'error',
        message: 'Yahoo Finance returned invalid price',
        price: 0, prevClose: 0, change: 0, changePct: 0, high: 0, low: 0,
        source: 'yahoo-invalid',
      });
    }

    const normalized = {
      price:      +price.toFixed(4),
      prevClose:  +prevClose.toFixed(4),
      change:     +change.toFixed(4),
      changePct:  +changePct.toFixed(2),
      high:       +high.toFixed(4),
      low:        +low.toFixed(4),
      source:     'yahoo',
      symbol:     upperSymbol,
      yahooSymbol,
      // Pass through meta fields useful for client display
      currency:   meta.currency || 'USD',
      exchange:   meta.exchangeName || '',
      longName:   meta.longName || meta.shortName || upperSymbol,
      updatedAt:  meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : new Date().toISOString(),
    };

    // Cache only valid responses
    _macroCache.set(upperSymbol, { data: normalized, ts: now });

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Macro-Cache', 'MISS');
    return res.status(200).json(normalized);
  } catch (e) {
    console.error(`[macro-proxy] Upstream error for ${yahooSymbol}:`, e.message);
    return res.status(502).json({
      status: 'error',
      message: 'Upstream request failed: ' + e.message,
      price: 0, prevClose: 0, change: 0, changePct: 0, high: 0, low: 0,
      source: 'proxy-error',
    });
  }
}
