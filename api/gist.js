/**
 * Gist Proxy — fetches AND pushes gist content server-side
 *
 * WHY: Mobile browsers have issues calling GitHub API directly:
 *   1. Private gists need auth token in header → CORS preflight fails on some networks
 *   2. GitHub API rate limits unauthenticated requests per IP → shared IPs get blocked
 *   3. Some mobile networks/proxies block api.github.com
 *
 * SOLUTION: This proxy handles all GitHub API calls server-side.
 *
 * Usage:
 *   GET  /api/gist?id=GIST_ID&token=TOKEN     → fetch gist (pull)
 *   POST /api/gist {action:'push', gistId, token, data} → create/update gist (push)
 *
 * Returns:
 *   GET: { success, trades, riskCfg, gistId, tradeCount }
 *   POST: { success, gistId, action }
 */

const GIST_FILENAME = 'trade-journal.json';
const GIST_DESC = 'Multi-Asset Analyst Pro — Trade Journal Backup';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') return handlePull(req, res);
  if (req.method === 'POST') return handlePush(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
}

// ── PULL: Fetch gist content ────────────────────────────────────
async function handlePull(req, res) {
  const { id, url, token } = req.query;

  let gistId = id || '';
  if (!gistId && url) {
    const match = url.match(/([a-f0-9]{20,})/i);
    if (match) gistId = match[1];
  }

  if (!gistId) {
    return res.status(400).json({ error: 'Missing gist ID or URL' });
  }

  try {
    const headers = { 'Accept': 'application/vnd.github.v3+json' };
    if (token) headers['Authorization'] = `token ${token}`;

    const response = await fetch(`https://api.github.com/gists/${gistId}`, { headers });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      let errMsg = errBody.message || response.statusText;
      if (response.status === 404) errMsg = 'Gist not found. Check the ID or make it public.';
      else if (response.status === 403) errMsg = 'Rate limited or private gist (token needed).';
      else if (response.status === 401) errMsg = 'Invalid token.';
      return res.status(response.status).json({ error: errMsg, gistId });
    }

    const gist = await response.json();
    const file = gist.files && gist.files[GIST_FILENAME];

    if (!file || !file.content) {
      // Try any JSON file
      const jsonFiles = Object.values(gist.files || {}).filter(f =>
        f.content && f.content.trim().startsWith('{')
      );
      if (jsonFiles.length === 0) {
        return res.status(404).json({ error: 'No trade-journal.json found in gist', gistId });
      }
      const data = JSON.parse(jsonFiles[0].content);
      return res.status(200).json({
        success: true,
        trades: data.trades || [],
        riskCfg: data.riskCfg || null,
        gistId,
        tradeCount: (data.trades || []).length,
      });
    }

    const data = JSON.parse(file.content);
    return res.status(200).json({
      success: true,
      trades: data.trades || [],
      riskCfg: data.riskCfg || null,
      gistId,
      tradeCount: (data.trades || []).length,
    });
  } catch (e) {
    console.error('[gist-proxy] Pull error:', e.message);
    return res.status(502).json({ error: 'Failed to fetch gist: ' + e.message, gistId });
  }
}

// ── PUSH: Create or update gist ─────────────────────────────────
async function handlePush(req, res) {
  const { action, gistId, token, data } = req.body || {};

  if (action !== 'push') {
    return res.status(400).json({ error: 'Invalid action. Use action: "push".' });
  }
  if (!token) {
    return res.status(401).json({ error: 'GitHub token required for push.' });
  }
  if (!data) {
    return res.status(400).json({ error: 'No data provided.' });
  }

  try {
    const headers = {
      'Authorization': `token ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github.v3+json',
    };

    let response;
    let actionType;

    if (gistId) {
      // Update existing gist
      actionType = 'updated';
      response = await fetch(`https://api.github.com/gists/${gistId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          description: GIST_DESC,
          files: { [GIST_FILENAME]: { content: data } },
        }),
      });
    } else {
      // Create new gist
      actionType = 'created';
      response = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          description: GIST_DESC,
          public: false,
          files: { [GIST_FILENAME]: { content: data } },
        }),
      });
    }

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      let errMsg = errBody.message || response.statusText;
      if (response.status === 401) errMsg = 'Invalid or expired GitHub token.';
      else if (response.status === 403) errMsg = 'Token lacks "gist" scope.';
      else if (response.status === 404) errMsg = 'Gist not found (may have been deleted).';
      return res.status(response.status).json({ error: errMsg, success: false });
    }

    const gist = await response.json();

    return res.status(200).json({
      success: true,
      gistId: gist.id,
      action: actionType,
    });
  } catch (e) {
    console.error('[gist-proxy] Push error:', e.message);
    return res.status(502).json({ error: 'Failed to push gist: ' + e.message, success: false });
  }
}
