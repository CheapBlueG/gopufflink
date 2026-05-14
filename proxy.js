const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const fetch     = require('node-fetch');
const puppeteer = require('puppeteer-extra');
const Stealth   = require('puppeteer-extra-plugin-stealth');
puppeteer.use(Stealth());

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

const CHROMIUM      = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
const CAPSOLVER_KEY = process.env.CAPSOLVER_KEY || '';
const HASH_PRODUCTS = '05f6be4b25f1fc8c6e8bcf89f51f00bcc3e4dade63875d33cd3f6bc5ca0e9c87';

let _browser = null;

async function getBrowser() {
  if (!_browser) {
    _browser = await puppeteer.launch({
      executablePath: CHROMIUM,
      headless: 'new',
      args: [
        '--no-sandbox','--disable-setuid-sandbox',
        '--disable-dev-shm-usage','--disable-gpu',
        '--no-zygote','--window-size=1280,800',
      ],
    });
    console.log('[browser] ✅ Chromium launched');
  }
  return _browser;
}

// ── CAPSOLVER: solve Cloudflare Turnstile ─────────────────────────────────────
async function solveTurnstile(pageUrl, siteKey) {
  if (!CAPSOLVER_KEY) throw new Error('No CAPSOLVER_KEY set');
  console.log('[capsolver] Solving Cloudflare challenge...');

  // Create task
  const createRes = await fetch('https://api.capsolver.com/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: CAPSOLVER_KEY,
      task: {
        type:    'AntiCloudflareTask',
        websiteURL: pageUrl,
        websiteKey: siteKey || '0x4AAAAAAA',
        proxy:   '',
      }
    })
  });
  const createData = await createRes.json();
  if (createData.errorId) throw new Error(`Capsolver create error: ${createData.errorDescription}`);
  const taskId = createData.taskId;
  console.log(`[capsolver] Task created: ${taskId}`);

  // Poll for result
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const resultRes = await fetch('https://api.capsolver.com/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: CAPSOLVER_KEY, taskId })
    });
    const result = await resultRes.json();
    if (result.status === 'ready') {
      console.log('[capsolver] ✅ Challenge solved');
      return result.solution;
    }
    console.log(`[capsolver] Waiting... (${i+1}/24)`);
  }
  throw new Error('Capsolver timeout');
}

// ── FETCH ORDER PAGE WITH CHALLENGE SOLVING ───────────────────────────────────
async function fetchOrderByPage(orderId, shareCode) {
  const browser      = await getBrowser();
  const page         = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  let orderData   = null;
  let productData = null;

  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('/graphql')) return;
    try {
      const json = await response.json().catch(() => null);
      if (!json) return;
      if (json?.data?.orderProgress)  { orderData   = json; console.log('[intercept] ✅ Order'); }
      if (json?.data?.view?.products) { productData = json; console.log('[intercept] ✅ Products'); }
    } catch(e) {}
  });

  const trackingUrl = `https://www.gopuff.com/order-progress/${orderId}?share=${shareCode}`;
  console.log(`[browser] Loading ${trackingUrl}`);

  try {
    await page.goto(trackingUrl, { waitUntil: 'load', timeout: 45000 });
    const title = await page.title();
    console.log(`[browser] Title: ${title}`);

    if (title.includes('moment') || title.includes('Cloudflare')) {
      console.log('[browser] Cloudflare challenge detected — using Capsolver...');

      // Extract Turnstile sitekey from page
      const siteKey = await page.evaluate(() => {
        const el = document.querySelector('[data-sitekey]');
        return el ? el.getAttribute('data-sitekey') : null;
      }).catch(() => null);
      console.log(`[browser] Sitekey: ${siteKey || 'not found, using default'}`);

      const solution = await solveTurnstile(trackingUrl, siteKey);

      // Inject the token and submit the challenge
      if (solution?.token) {
        await page.evaluate((token) => {
          const input = document.querySelector('[name="cf-turnstile-response"]') ||
                        document.querySelector('input[type="hidden"]');
          if (input) input.value = token;
          const form = document.querySelector('form');
          if (form) form.submit();
        }, solution.token);
        await page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }).catch(() => {});
        console.log(`[browser] After solve title: ${await page.title()}`);
      }

      // Wait for GoPuff's JS to run and make API calls
      await new Promise(r => setTimeout(r, 8000));
    } else {
      await new Promise(r => setTimeout(r, 6000));
    }

    console.log(`[browser] Order: ${orderData ? '✅' : '❌'}`);
  } catch(e) {
    console.warn('[browser] Error:', e.message);
  } finally {
    await page.close();
  }

  if (!orderData) throw new Error('No order data captured');
  return { order: orderData, products: productData };
}

// ── INTERCEPT APPROACH ────────────────────────────────────────────────────────
// Navigate to the REAL GoPuff tracking page.
// GoPuff's own JavaScript makes the API calls — we just intercept the responses.
// Cloudflare can't block this — it's GoPuff's own code running in Chrome.
async function fetchOrderByPage(orderId, shareCode) {
  const browser = await getBrowser();
  const page    = await browser.newPage();

  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  let orderData   = null;
  let productData = null;

  // Log ALL responses to see what the page is actually loading
  page.on('response', async (response) => {
    const url    = response.url();
    const status = response.status();
    if (url.includes('gopuff.com')) {
      console.log(`[intercept] ${status} ${url.slice(0, 100)}`);
    }
    if (!url.includes('/graphql')) return;
    try {
      const json = await response.json().catch(() => null);
      if (!json) return;
      if (json?.data?.orderProgress)  { orderData   = json; console.log('[intercept] ✅ Order data captured'); }
      if (json?.data?.view?.products) { productData = json; console.log('[intercept] ✅ Product data captured'); }
    } catch(e) {}
  });

  const trackingUrl = `https://www.gopuff.com/order-progress/${orderId}?share=${shareCode}`;
  console.log(`[browser] Loading: ${trackingUrl}`);

  try {
    await page.goto(trackingUrl, { waitUntil: 'load', timeout: 45000 });
    const finalUrl = page.url();
    const title    = await page.title();
    console.log(`[browser] Final URL: ${finalUrl}`);
    console.log(`[browser] Page title: ${title}`);
    // Wait longer for JS to execute and make API calls
    await new Promise(r => setTimeout(r, 8000));
    console.log(`[browser] Order data: ${orderData ? '✅' : '❌'}`);
  } catch(e) {
    console.warn('[browser] Page load warning:', e.message);
  } finally {
    await page.close();
  }

  if (!orderData) throw new Error('No order data intercepted — page may not have loaded');
  return { order: orderData, products: productData };
}

// ── SHARED STORE ──────────────────────────────────────────────────────────────
const { store } = require('./bot');

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get('/api/track', async (req, res) => {
  const { orderId, shareCode } = req.query;
  if (!orderId || !shareCode) return res.status(400).json({ error: 'orderId and shareCode required' });
  try {
    const { order, products } = await fetchOrderByPage(orderId, shareCode);
    res.json({ order, products });
  } catch(e) {
    console.error('[/api/track]', e.message);
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/resolve/:shortId', (req, res) => {
  const entry = store.get(req.params.shortId);
  if (!entry) return res.status(404).json({ error: 'Link not found' });
  res.json({ url: entry.gopuffUrl, orderId: entry.orderId, shareCode: entry.shareCode });
});

// Legacy /t/:shortId → redirect to clean URL
app.get('/t/:shortId', (req, res) => {
  res.redirect(301, `/${req.params.shortId}`);
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
  getBrowser().catch(e => console.warn('[browser] Warmup failed:', e.message));
});
