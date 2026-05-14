/**
 * GoPuff Tracker — Proxy Server
 * npm install express cors node-fetch hpagent node-telegram-bot-api
 * node proxy.js
 */

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fetch   = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');

// ── PLAYWRIGHT STEALTH — gets real cf_clearance cookies from GoPuff ──────────
const { chromium } = require('playwright-extra');
const stealth      = require('puppeteer-extra-plugin-stealth');
chromium.use(stealth());

let _browser     = null;
let _cfCookies   = '';
let _cookieExp   = 0;

async function getBrowser() {
  if (!_browser) {
    _browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process', '--disable-dev-shm-usage'],
    });
    console.log('[browser] Chromium launched');
  }
  return _browser;
}

async function refreshCFCookies() {
  console.log('[browser] Fetching fresh Cloudflare cookies...');
  const browser = await getBrowser();
  const ctx  = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36' });
  const page = await ctx.newPage();
  try {
    await page.goto('https://www.gopuff.com/go/order-tracker', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000); // let Cloudflare challenge complete
    const cookies = await ctx.cookies('https://www.gopuff.com');
    _cfCookies  = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    _cookieExp  = Date.now() + 25 * 60 * 1000; // refresh every 25 min
    const hasCF = cookies.some(c => c.name === 'cf_clearance');
    console.log(`[browser] Got ${cookies.length} cookies, cf_clearance: ${hasCF ? '✅' : '❌'}`);
  } finally {
    await ctx.close();
  }
}

async function getCFCookies() {
  if (Date.now() < _cookieExp && _cfCookies) return _cfCookies;
  await refreshCFCookies();
  return _cfCookies;
}

// Warm up cookies on startup
refreshCFCookies().catch(e => console.warn('[browser] Startup warmup failed:', e.message));

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// ── PROXY SETUP ───────────────────────────────────────────────────────────────
// ScraperAPI handles Cloudflare bypass with real residential IPs.
// Sign up free at scraperapi.com and set SCRAPER_API_KEY env var.
// Falls back to custom residential proxy if SCRAPER_API_KEY not set.
const PROXY_USER    = process.env.PROXY_USER    || '';
const PROXY_PASS    = process.env.PROXY_PASS    || '';
const PROXY_HOST    = process.env.PROXY_HOST    || '';
const SCRAPER_KEY   = process.env.SCRAPER_API_KEY || '';

function makeAgent() {
  if (SCRAPER_KEY) {
    console.log('[proxy] Using ScraperAPI residential proxy');
    return new HttpsProxyAgent(
      `http://scraperapi:${SCRAPER_KEY}@proxy-server.scraperapi.com:8001`,
      { rejectUnauthorized: false }
    );
  }
  if (PROXY_HOST) {
    console.log('[proxy] Using custom residential proxy');
    return new HttpsProxyAgent(
      `http://${PROXY_USER}:${PROXY_PASS}@${PROXY_HOST}`,
      { rejectUnauthorized: false }
    );
  }
  console.warn('[proxy] ⚠️  No proxy configured');
  return null;
}

const agent = makeAgent();

// ── GOPUFF CONSTANTS ──────────────────────────────────────────────────────────
const GQL = 'https://www.gopuff.com/graphql';

const HASH_ORDER    = '2255154c1b1c39ec15f48cbbe9034ac51df4060a71be751e75eaabe9c287e66fd8';
const HASH_PRODUCTS = '05f6be4b25f1fc8c6e8bcf89f51f00bcc3e4dade63875d33cd3f6bc5ca0e9c87';
const HASH_STREAM   = '8750177ac802f7020af237cc238940ecb8c54d8ee03e4e3fb8e6e7e28f00fafa';
const HASH_ESTIMATE = 'dcfca9ce9b6183627fc3cd0d6936716fea8165695ae8e5b375abb050609a7b91';

// ── BEARER TOKEN ──────────────────────────────────────────────────────────────
let BEARER = process.env.GOPUFF_BEARER || '';

// ── BASE HEADERS ─────────────────────────────────────────────────────────────
async function HEADERS() {
  const cookies = await getCFCookies().catch(() => '');
  return {
    'Accept':                   'application/graphql+json, application/json',
    'Accept-Language':          'en-US,en;q=0.9',
    'Accept-Encoding':          'gzip, deflate, br',
    'Authorization':            `Bearer ${BEARER}`,
    'Cookie':                   cookies,
    'User-Agent':               'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
    'x-gopuff-client-platform': 'web',
    'x-gopuff-client-version':  '12.5.30-193096',
    'x-gopuff-version':         '12005030',
    'x-gp-point-of-sale':       'US',
    'Origin':                   'https://www.gopuff.com',
    'Referer':                  'https://www.gopuff.com/',
    'sec-fetch-dest':           'empty',
    'sec-fetch-mode':           'cors',
    'sec-fetch-site':           'same-origin',
  };
}

// ── TOKEN REFRESH ─────────────────────────────────────────────────────────────
async function refreshGuestToken() {
  console.log('[token] Attempting auto-refresh...');
  try {
    const r = await fetch('https://www.gopuff.com/go/order-tracker', {
      agent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'Accept': 'text/html',
      },
    });
    const rawCookies = r.headers.raw?.()?.['set-cookie'] || [];
    const cookieStr  = Array.isArray(rawCookies) ? rawCookies.join('; ') : String(rawCookies);
    const match = cookieStr.match(/guest_token=([^;]+)/);
    if (match) {
      const parsed = JSON.parse(decodeURIComponent(match[1]));
      if (parsed?.accessToken) {
        BEARER = parsed.accessToken;
        console.log('[token] ✅ Refreshed via cookie');
        return;
      }
    }
  } catch (e) {
    console.warn('[token] Cookie method failed:', e.message);
  }
  console.warn('[token] ⚠️ Auto-refresh failed — using env token');
}

function scheduleTokenRefresh() {
  try {
    const payload  = JSON.parse(Buffer.from(BEARER.split('.')[1], 'base64').toString());
    const refreshMs = (payload.exp * 1000) - Date.now() - 3600_000;
    if (refreshMs > 0) {
      console.log(`[token] Next refresh in ${Math.round(refreshMs / 60000)} min`);
      setTimeout(async () => { await refreshGuestToken(); scheduleTokenRefresh(); }, refreshMs);
    } else {
      console.log('[token] Token expiring soon, refreshing now...');
      refreshGuestToken().then(scheduleTokenRefresh);
    }
  } catch (e) {
    console.warn('[token] Could not schedule refresh:', e.message);
  }
}

// ── GRAPHQL HELPER ────────────────────────────────────────────────────────────
async function gqlGet(operationName, variables, hash) {
  const v   = encodeURIComponent(JSON.stringify(variables));
  const ext = encodeURIComponent(JSON.stringify({ persistedQuery: { sha256Hash: hash, version: 1 } }));
  const url = `${GQL}?operationName=${operationName}&variables=${v}&extensions=${ext}`;
  const hdrs = await HEADERS();

  console.log(`[gql] ${operationName} → direct (stealth cookies)`);
  const r = await fetch(url, { headers: hdrs });
  console.log(`[gql] ${operationName} ← ${r.status}`);

  if (r.status === 401) {
    await refreshGuestToken();
    const r2 = await fetch(url, { headers: await HEADERS() });
    if (!r2.ok) throw new Error(`GoPuff ${r2.status}`);
    return r2.json();
  }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    // If still 403 after stealth cookies, force refresh and retry once
    if (r.status === 403) {
      console.log('[gql] 403 — refreshing CF cookies and retrying...');
      _cookieExp = 0; // force refresh
      const hdrs2 = await HEADERS();
      const r3 = await fetch(url, { headers: hdrs2 });
      console.log(`[gql] ${operationName} retry ← ${r3.status}`);
      if (r3.ok) return r3.json();
      const b3 = await r3.text().catch(() => '');
      throw new Error(`GoPuff ${r3.status}: ${b3.slice(0, 200)}`);
    }
    throw new Error(`GoPuff ${r.status}: ${body.slice(0, 200)}`);
  }
  return r.json();
}

// ── SHARED STORE ──────────────────────────────────────────────────────────────
const { store } = require('./bot');

// ── ROUTES ────────────────────────────────────────────────────────────────────

// Bearer token — lets the browser call GoPuff directly (bypasses Cloudflare
// since the request comes from the user's own residential IP)
app.get('/api/token', (req, res) => {
  res.json({ bearer: BEARER });
});

// Resolve short link → gopuff URL
app.get('/api/resolve/:shortId', (req, res) => {
  const entry = store.get(req.params.shortId);
  if (!entry) return res.status(404).json({ error: 'Link not found or expired' });
  res.json({ url: entry.gopuffUrl });
});

// Tracking data
app.get('/api/track', async (req, res) => {
  const { orderId, shareCode } = req.query;
  if (!orderId || !shareCode) return res.status(400).json({ error: 'orderId and shareCode required' });
  try {
    const data = await gqlGet('GetSharedOrderStatus', { orderId, shareCode }, HASH_ORDER);
    res.json(data);
  } catch (e) {
    console.error('[/api/track]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// Product details
app.get('/api/products', async (req, res) => {
  const productIds = [...new Set((req.query.ids || '').split(',').map(Number).filter(Boolean))];
  if (!productIds.length) return res.status(400).json({ error: 'ids required' });
  try {
    const data = await gqlGet('Products', { platform: 'WEB', productIds }, HASH_PRODUCTS);
    res.json(data);
  } catch (e) {
    console.error('[/api/products]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// Delivery estimate
app.get('/api/estimate', async (req, res) => {
  const { zoneId, lat, lng } = req.query;
  if (!zoneId || !lat || !lng) return res.status(400).json({ error: 'zoneId, lat, lng required' });
  try {
    const data = await gqlGet('DeliveryEstimate', {
      deliveryZoneId:   Number(zoneId),
      fastestAvailable: true,
      isDeferred:       false,
      latlng:           { lat: Number(lat), lng: Number(lng) },
      products:         [],
    }, HASH_ESTIMATE);
    const est = data?.data?.view?.deliveryEstimate || {};
    res.json({ from: est.from, to: est.to, priority: est.priority });
  } catch (e) {
    console.error('[/api/estimate]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// Real-time SSE stream
app.get('/api/stream', async (req, res) => {
  try {
    const data      = await gqlGet('GetChatEventsStream', {}, HASH_STREAM);
    const streamUrl = data?.data?.getChatEventStream?.url;
    if (!streamUrl) throw new Error('No stream URL from GoPuff');

    console.log('[stream] Connecting to:', streamUrl);
    const upstream = await fetch(streamUrl, {
      agent,
      headers: { ...HEADERS(), 'Accept': 'text/event-stream', 'Cache-Control': 'no-cache' },
    });
    if (!upstream.ok) throw new Error(`Stream ${upstream.status}`);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    const reader  = upstream.body.getReader();
    const decoder = new TextDecoder();
    req.on('close', () => reader.cancel());

    while (true) {
      const { done, value } = await reader.read();
      if (done) { res.end(); break; }
      res.write(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    console.error('[stream]', e.message);
    if (!res.headersSent) { res.setHeader('Content-Type', 'text/event-stream'); res.flushHeaders(); }
    res.write(': stream-error\n\n');
    res.end();
  }
});

// Short link → serve tracker page
app.get('/t/:shortId', (req, res) => {
  const entry = store.get(req.params.shortId);
  if (!entry) {
    return res.status(404).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#07080d;color:#fff">
        <h2>❌ Link not found</h2><p style="color:#9ca3af">This tracking link has expired or doesn't exist.</p>
      </body></html>`);
  }
  res.sendFile(path.join(__dirname, 'gopuff-tracker.html'));
});

// Static files
app.use(express.static(__dirname));

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`✅ GoPuff proxy running on port ${PORT}`);
  if (BEARER) scheduleTokenRefresh();
  else console.warn('[token] ⚠️  No GOPUFF_BEARER set — add it to Render env vars');
});

module.exports = { refreshGuestToken };
