const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const puppeteer = require('puppeteer-extra');
const Stealth   = require('puppeteer-extra-plugin-stealth');
puppeteer.use(Stealth());

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

const GQL          = 'https://www.gopuff.com/graphql';
const HASH_ORDER   = '2255154c1b1c39ec15f48cbbe9034ac51df4060a71be751e75eaabe9c287e66fd8';
const HASH_PRODUCTS= '05f6be4b25f1fc8c6e8bcf89f51f00bcc3e4dade63875d33cd3f6bc5ca0e9c87';
const CHROMIUM     = process.env.CHROMIUM_PATH || '/usr/bin/chromium';

// ── BROWSER SESSION ───────────────────────────────────────────────────────────
// One persistent Puppeteer page stays on gopuff.com.
// All API calls are made via page.evaluate(fetch) — same origin, Cloudflare can't block it.
let _browser    = null;
let _page       = null;
let _sessionExp = 0;
let _bearer     = process.env.GOPUFF_BEARER || '';

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

async function getPage() {
  if (_page && Date.now() < _sessionExp) return _page;

  const browser = await getBrowser();
  if (_page) await _page.close().catch(() => {});

  console.log('[browser] Opening GoPuff session...');
  _page = await browser.newPage();
  await _page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36');
  await _page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  // Visit GoPuff — stealth handles Cloudflare challenge automatically
  await _page.goto('https://www.gopuff.com/go/order-tracker', {
    waitUntil: 'networkidle2',
    timeout:   45000,
  });

  // Wait for Cloudflare to finish
  await new Promise(r => setTimeout(r, 4000));

  // Extract bearer token from localStorage
  const token = await _page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('token') || '{}').accessToken || ''; }
    catch(e) { return ''; }
  }).catch(() => '');
  if (token) { _bearer = token; console.log('[browser] ✅ Bearer token from page'); }

  const cookies = await _page.cookies();
  const hasCF   = cookies.some(c => c.name === 'cf_clearance');
  console.log(`[browser] ${cookies.length} cookies — cf_clearance: ${hasCF ? '✅' : '❌'}`);

  _sessionExp = Date.now() + 20 * 60 * 1000; // refresh every 20 min
  return _page;
}

// ── GRAPHQL VIA BROWSER ───────────────────────────────────────────────────────
// fetch() runs INSIDE Chromium on gopuff.com — same origin, Cloudflare allows it
async function gqlGet(operationName, variables, hash) {
  const v   = encodeURIComponent(JSON.stringify(variables));
  const ext = encodeURIComponent(JSON.stringify({ persistedQuery: { sha256Hash: hash, version: 1 } }));
  const url = `${GQL}?operationName=${operationName}&variables=${v}&extensions=${ext}`;

  const page = await getPage();
  console.log(`[gql] ${operationName}...`);

  const result = await page.evaluate(async (fetchUrl, bearer) => {
    const r = await fetch(fetchUrl, {
      headers: {
        'Authorization':            `Bearer ${bearer}`,
        'Accept':                   'application/graphql+json, application/json',
        'x-gopuff-client-platform': 'web',
        'x-gopuff-client-version':  '12.5.30-193096',
        'x-gopuff-version':         '12005030',
        'x-gp-point-of-sale':       'US',
      }
    });
    if (!r.ok) throw new Error(`GoPuff ${r.status}`);
    return r.json();
  }, url, _bearer);

  console.log(`[gql] ${operationName} ← ✅`);
  return result;
}

// ── SHARED STORE ──────────────────────────────────────────────────────────────
const { store } = require('./bot');

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get('/api/track', async (req, res) => {
  const { orderId, shareCode } = req.query;
  if (!orderId || !shareCode) return res.status(400).json({ error: 'orderId and shareCode required' });
  try {
    const data = await gqlGet('GetSharedOrderStatus', { orderId, shareCode }, HASH_ORDER);
    res.json(data);
  } catch(e) {
    console.error('[/api/track]', e.message);
    // If session expired, reset and retry once
    if (e.message.includes('403')) {
      _sessionExp = 0;
      try {
        const data = await gqlGet('GetSharedOrderStatus', { orderId, shareCode }, HASH_ORDER);
        return res.json(data);
      } catch(e2) {}
    }
    res.status(502).json({ error: e.message });
  }
});

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

app.get('/api/resolve/:shortId', (req, res) => {
  const entry = store.get(req.params.shortId);
  if (!entry) return res.status(404).json({ error: 'Link not found' });
  res.json({ url: entry.gopuffUrl, orderId: entry.orderId, shareCode: entry.shareCode });
});

app.get('/:shortId([a-f0-9]{8})', (req, res) => {
  if (!store.get(req.params.shortId)) {
    return res.status(404).send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#07080d;color:#fff"><h2>❌ Link not found</h2></body></html>`);
  }
  res.sendFile(path.join(__dirname, 'gopuff-tracker.html'));
});

app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  getPage().catch(e => console.warn('[browser] Warmup failed:', e.message));
});
