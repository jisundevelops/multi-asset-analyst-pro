/**
 * News Proxy — fetches real crypto news from RSS feeds
 *
 * Why: Browser can't fetch RSS feeds directly due to CORS. This serverless
 * proxy fetches from CoinDesk + CoinTelegraph RSS, parses XML, returns JSON.
 *
 * Usage: /api/news?asset=BTC&limit=5
 * Returns: [{ title, link, source, publishedAt, summary }]
 *
 * No API key needed — RSS feeds are public.
 */

const FEEDS = [
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'CoinDesk' },
  { url: 'https://cointelegraph.com/rss', source: 'CoinTelegraph' },
];

// Asset keyword filter — matches news titles mentioning the asset
const ASSET_KEYWORDS = {
  BTC:    ['bitcoin', 'btc', 'btcusdt'],
  ETH:    ['ethereum', 'eth', 'ether'],
  BNB:    ['bnb', 'binance coin'],
  SOL:    ['solana', 'sol'],
  XAU:    ['gold', 'xau', 'precious metal'],
  'EUR/USD': ['euro', 'eur', 'dollar', 'eurusd', 'forex'],
  'GBP/USD': ['pound', 'gbp', 'sterling', 'gbpusd'],
  'USD/JPY': ['yen', 'jpy', 'usdjpy', 'japan'],
};

function parseRSS(xml, source) {
  const items = [];
  // Simple regex-based RSS parsing (no DOMParser in Node.js without libs)
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const title = (itemXml.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i) ||
                   itemXml.match(/<title>([\s\S]*?)<\/title>/i))?.[1]?.trim() || '';
    const link = (itemXml.match(/<link>([\s\S]*?)<\/link>/i))?.[1]?.trim() || '';
    const pubDate = (itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/i))?.[1]?.trim() || '';
    const description = (itemXml.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i) ||
                        itemXml.match(/<description>([\s\S]*?)<\/description>/i))?.[1]?.trim() || '';
    // Strip HTML from description
    const summary = description.replace(/<[^>]+>/g, '').slice(0, 200).trim();

    if (title) {
      items.push({
        title,
        link,
        source,
        publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
        summary,
      });
    }
  }
  return items;
}

function matchesAsset(item, assetKey) {
  if (!assetKey) return true; // no filter → all news
  const keywords = ASSET_KEYWORDS[assetKey] || [assetKey.toLowerCase()];
  const text = (item.title + ' ' + item.summary).toLowerCase();
  return keywords.some(kw => text.includes(kw));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { asset, limit } = req.query;
  const maxItems = Math.min(parseInt(limit, 10) || 8, 20);

  try {
    const fetches = FEEDS.map(async (feed) => {
      try {
        const response = await fetch(feed.url, {
          headers: { 'User-Agent': 'BTC-Analyst-Pro/4.0' },
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) return [];
        const xml = await response.text();
        return parseRSS(xml, feed.source);
      } catch (e) {
        console.error(`[news-proxy] Failed to fetch ${feed.source}:`, e.message);
        return [];
      }
    });

    const results = await Promise.all(fetches);
    let allItems = results.flat();

    // Sort by date descending (newest first)
    allItems.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    // Filter by asset if specified
    if (asset) {
      const filtered = allItems.filter(item => matchesAsset(item, asset));
      // If too few asset-specific news, fall back to general news
      if (filtered.length >= 3) {
        allItems = filtered;
      }
    }

    // Limit
    allItems = allItems.slice(0, maxItems);

    // Cache for 5 minutes (news doesn't change every second)
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.setHeader('X-News-Source', 'rss');
    return res.status(200).json({ items: allItems, count: allItems.length, source: 'rss' });
  } catch (e) {
    console.error('[news-proxy] Error:', e.message);
    return res.status(502).json({ error: 'Failed to fetch news', items: [], count: 0 });
  }
}
