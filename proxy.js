const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fetch   = require('node-fetch');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

// ── GOPUFF CONSTANTS ──────────────────────────────────────────────────────────
const GQL          = 'https://www.gopuff.com/graphql';
const HASH_ORDER   = '2255154c1b1c39ec15f48cbbe9034ac51df4060a71be751e75eaabe9c287e66fd8';
const HASH_PRODUCTS= '05f6be4b25f1fc8c6e8bcf89f51f00bcc3e4dade63875d33cd3f6bc5ca0e9c87';
const CHROMIUM     = process.env.CHROMIUM_PATH || '/usr/bin/chromium';

// ── BROWSER & COOKIE CACHE ────────────────────────────────────────────────────
let _browser   = null;
let _cookies   = '';
let _cookieExp = 0;
let _bearer    = process.env.GOPUFF_BEARER || '';

async function getBrowser() {
  if (!_browser) {
    _browser = await puppeteer.launch({
      executablePath: CHROMIUM,
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--single-process'],
    });
    console.log('[browser] ✅ Chromium launched');
  }
  return _browser;
}

async function refreshCookies() {
  console.log('[browser] Refreshing GoPuff cookies...');
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36');
  try {
    await page.goto('https://www.gopuff.com/go/order-tracker', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    const cookies = await page.cookies();
    _cookies   = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    _cookieExp = Date.now() + 20 * 60 * 1000; // 20 min
    const hasCF = cookies.some(c => c.name === 'cf_clearance');
    // Also grab bearer from page context if available
    const token = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('guest_token') || '{}').accessToken || ''; } catch(e){ return ''; }
    }).catch(() => '');
    if (token) { _bearer = token; console.log('[browser] Bearer refreshed from page'); }
    console.log(`[browser] ${cookies.length} cookies — cf_clearance: ${hasCF ? '✅' : '❌'}`);
  } finally {
    await page.close();
  }
}

async function getCookies() {
  if (Date.now() < _cookieExp && _cookies) return _cookies;
  await refreshCookies();
  return _cookies;
}

// ── GRAPHQL HELPER ────────────────────────────────────────────────────────────
async function gqlGet(operationName, variables, hash) {
  const v   = encodeURIComponent(JSON.stringify(variables));
  const ext = encodeURIComponent(JSON.stringify({ persistedQuery: { sha256Hash: hash, version: 1 } }));
  const url = `${GQL}?operationName=${operationName}&variables=${v}&extensions=${ext}`;
  const cookies = await getCookies();

  console.log(`[gql] ${operationName}...`);
  const r = await fetch(url, {
    headers: {
      'Accept':                   'application/graphql+json, application/json',
      'Accept-Language':          'en-US,en;q=0.9',
      'Authorization':            `Bearer ${_bearer}`,
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
    }
  });

  console.log(`[gql] ${operationName} ← ${r.status}`);
  if (r.status === 403) {
    // Force cookie refresh and retry once
    _cookieExp = 0;
    const cookies2 = await getCookies();
    const r2 = await fetch(url, { headers: { ...arguments[0], Cookie: cookies2 } });
    if (!r2.ok) throw new Error(`GoPuff ${r2.status}`);
    return r2.json();
  }
  if (!r.ok) throw new Error(`GoPuff ${r.status}`);
  return r.json();
}

// ── SHARED STORE ──────────────────────────────────────────────────────────────
const { store } = require('./bot');

// ── ROUTES ────────────────────────────────────────────────────────────────────

// Order tracking
app.get('/api/track', async (req, res) => {
  const { orderId, shareCode } = req.query;
  if (!orderId || !shareCode) return res.status(400).json({ error: 'orderId and shareCode required' });
  try {
    const data = await gqlGet('GetSharedOrderStatus', { orderId, shareCode }, HASH_ORDER);
    res.json(data);
  } catch(e) {
    console.error('[/api/track]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// Product details
app.get('/api/products', async (req, res) => {
  const productIds = [...new Set((req.query.ids||'').split(',').map(Number).filter(Boolean))];
  if (!productIds.length) return res.status(400).json({ error: 'ids required' });
  try {
    const data = await gqlGet('Products', { platform: 'WEB', productIds }, HASH_PRODUCTS);
    res.json(data);
  } catch(e) {
    console.error('[/api/products]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// Resolve short link
app.get('/api/resolve/:shortId', (req, res) => {
  const entry = store.get(req.params.shortId);
  if (!entry) return res.status(404).json({ error: 'Link not found' });
  res.json({ url: entry.gopuffUrl, orderId: entry.orderId, shareCode: entry.shareCode });
});

// Short link → tracker page
app.get('/:shortId([a-f0-9]{8})', (req, res) => {
  if (!store.get(req.params.shortId)) {
    return res.status(404).send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#07080d;color:#fff"><h2>❌ Link not found</h2></body></html>`);
  }
  res.sendFile(path.join(__dirname, 'gopuff-tracker.html'));
});

app.use(express.static(__dirname));

// ── START ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  // Warm up browser on startup
  refreshCookies().catch(e => console.warn('[browser] Warmup failed:', e.message));
});
