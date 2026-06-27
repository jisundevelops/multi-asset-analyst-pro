/**
 * TwelveData API Proxy with server-side key ban tracking
 *
 * Hides API keys from frontend — keys stored in Vercel environment variables.
 *
 * Usage: /api/td?_ep=time_series&symbol=BTC/USD&interval=1min&...
 *
 * Vercel env vars needed:
 *   TD_KEY_1 through TD_KEY_10
 *
 * ARCHITECTURE (fixed):
 *   Previously: stateless round-robin by minute (Math.floor(Date.now()/60000) % n).
 *   Problem: all parallel calls within a minute hit the SAME single key. If
 *   fetchMacroData fired 4 calls + fetchCrossAssetCloses fired 4 more, they
 *   all stacked on one key → easy 429. The client-side ban tracking was
 *   fictional because the proxy stripped apikey and the client had no way
 *   to know which real key was used.
 *
 *   Now: server holds per-key state in a module-level Map (survives across
 *   warm lambda invocations on Vercel). State includes:
 *     - recent call timestamps (for client-side-equivalent rate limiting)
 *     - temporary ban until (after 429)
 *     - daily ban until (after daily-credit exhaustion, until next UTC midnight)
 *   Picks the LEAST-RECENTLY-USED non-banned key per request, bans on 429,
 *   and emits an `x-td-key-slot` response header so the client can sync its
 *   OWN tracking (kept for analytics/debug UI — no longer the source of truth).
 */

const TD_CALLS_PER_KEY_PER_MIN = 8;          // free-tier limit
const TD_BAN_COOLDOWN_MS        = 65 * 1000; // 65s after a 429
const TD_DAILY_BAN_MS           = 24 * 60 * 60 * 1000;

// ── Module-level state (survives across warm lambda invocations) ──────────
// On a cold start this is fresh; on warm calls it persists. Vercel may spin
// up multiple lambdas in parallel — each has its own state, but the upstream
// API still rate-limits per-key (not per-lambda), so over time all lambdas
// converge to "this key is bad, try the next one". Acceptable for free tier.
//
// `keyState` is a Map<slotIndex, {callTimes:[], banned:bool, banUntil:num,
//                                  dailyBanned:bool, dailyBanUntil:num}>
let _keyStateInitialized = false;
const _keyState = new Map();
const _keySlots = []; // array of {slot, key} — populated on first call

function _initKeyState(keys) {
  if (_keyStateInitialized) return;
  _keySlots.length = 0;
  _keyState.clear();
  keys.forEach((k, i) => {
    _keySlots.push({ slot: i + 1, key: k });
    _keyState.set(i + 1, {
      slot: i + 1,
      key: k,
      callTimes: [],
      banned: false,
      banUntil: 0,
      dailyBanned: false,
      dailyBanUntil: 0,
      totalCalls: 0,
      failedCalls: 0,
    });
  });
  _keyStateInitialized = true;
}

function _nextUTCMidnight() {
  const now = new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  return midnight.getTime();
}

function _selectKeySlot() {
  const now = Date.now();
  // First pass: auto-unban expired bans
  for (const [slot, st] of _keyState) {
    if (st.dailyBanned && now >= st.dailyBanUntil) {
      st.dailyBanned = false;
      st.dailyBanUntil = 0;
      st.callTimes = [];
      console.log(`[td-proxy] Slot ${slot} daily ban expired, back in rotation`);
    }
    if (st.banned && now >= st.banUntil) {
      st.banned = false;
      st.callTimes = [];
    }
  }

  // Pick least-recently-used non-banned, non-daily-banned slot
  let best = null;
  let bestScore = Infinity;
  for (const [slot, st] of _keyState) {
    if (st.dailyBanned) continue;
    if (st.banned) continue;
    // Clean old timestamps (keep last 65s)
    st.callTimes = st.callTimes.filter(t => now - t < 65000);
    const score = st.callTimes.length;
    if (score < bestScore) {
      bestScore = score;
      best = st;
    }
  }

  // If all banned, pick the one that unbans soonest (preferring non-daily-banned)
  if (!best) {
    const nonDaily = [..._keyState.values()].filter(s => !s.dailyBanned);
    if (nonDaily.length) {
      best = nonDaily.reduce((a, b) => a.banUntil < b.banUntil ? a : b);
    } else {
      // All daily-banned — pick soonest daily reset
      best = [..._keyState.values()].reduce((a, b) => a.dailyBanUntil < b.dailyBanUntil ? a : b);
    }
  }

  // Record this call's timestamp
  best.callTimes.push(now);
  best.totalCalls++;
  return best;
}

function _banKeySlot(slot, isDaily) {
  const st = _keyState.get(slot);
  if (!st) return;
  if (isDaily) {
    if (!st.dailyBanned) {
      st.dailyBanned = true;
      st.dailyBanUntil = _nextUTCMidnight();
      st.failedCalls++;
      console.warn(`[td-proxy] Slot ${slot} DAILY CREDITS EXHAUSTED, banned until next UTC midnight`);
    }
  } else {
    st.banned = true;
    st.banUntil = Date.now() + TD_BAN_COOLDOWN_MS;
    st.failedCalls++;
    console.warn(`[td-proxy] Slot ${slot} rate-limited (429), banned for 65s`);
  }
}

// ── Detect daily-credit exhaustion vs per-minute rate limit ───────────────
function _isDailyLimitError(msg) {
  if (!msg) return false;
  const m = String(msg).toLowerCase();
  return (
    m.includes('run out of api credit') ||
    m.includes('daily limit')           ||
    m.includes('daily api calls limit') ||
    m.includes('credits were used')     ||
    m.includes('out of credits')
  );
}

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

  _initKeyState(keys);

  // Pick the best key slot
  const keyState = _selectKeySlot();
  const apiKey   = keyState.key;
  const slotIdx  = keyState.slot;

  // Build upstream URL
  const qs          = new URLSearchParams({ ...params, apikey: apiKey }).toString();
  const upstreamUrl = `https://api.twelvedata.com/${_ep}?${qs}`;

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: { 'User-Agent': 'BTC-Analyst-Pro/4.0' },
      signal: AbortSignal.timeout(12000),
    });

    // 429 handling: ban the slot, then propagate
    if (upstream.status === 429) {
      let body = null;
      try { body = await upstream.json(); } catch (_) {}
      const isDaily = body?.message && _isDailyLimitError(body.message);
      _banKeySlot(slotIdx, isDaily);
      // Pass the message back so the client can show a friendly error
      const msg = body?.message || (isDaily ? 'Daily API credits exhausted' : 'Rate limited');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('x-td-key-slot', String(slotIdx));
      res.setHeader('x-td-key-banned', isDaily ? 'daily' : 'temp');
      return res.status(429).json({ status: 'error', message: msg, code: isDaily ? 'daily_limit' : 'rate_limit' });
    }

    const data = await upstream.json();

    // Twelve Data returns 200 with {status:'error', message:'...'} for rate
    // limits and daily exhaustion (instead of HTTP 429). Detect those too.
    if (data && data.status === 'error' && data.message) {
      const isDaily = _isDailyLimitError(data.message);
      if (isDaily || /rate limit|limit being/i.test(data.message)) {
        _banKeySlot(slotIdx, isDaily);
      }
      // Forward the error to the client (with slot header for debugging)
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('x-td-key-slot', String(slotIdx));
      if (isDaily) res.setHeader('x-td-key-banned', 'daily');
      return res.status(upstream.status || 200).json(data);
    }

    // Short cache for time-series, no cache for price/quote
    if (_ep === 'time_series') {
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }
    // Echo back which slot served this request — clients can sync their own
    // tracking (purely advisory now; server is the source of truth).
    res.setHeader('x-td-key-slot', String(slotIdx));

    return res.status(upstream.status).json(data);
  } catch (e) {
    console.error(`[td-proxy] Upstream error (slot ${slotIdx}):`, e.message);
    return res.status(502).json({ status: 'error', message: 'Upstream request failed' });
  }
}
