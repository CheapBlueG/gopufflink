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

let _browser = null;

async function getBrowser() {
  if (!_browser) {
    _browser = await puppeteer.launch({
      executablePath: CHROMIUM,
      headless: 'new',
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
        '--no-zygote', '--window-size=1280,800',
      ],
    });
    console.log('[browser] ✅ Chromium launched');
  }
  return _browser;
}

// ── CAPSOLVER: solve Cloudflare Turnstile ─────────────────────────────────────
async function solveTurnstile(pageUrl, siteKey) {
  if (!CAPSOLVER_KEY) throw new Error('No CAPSOLVER_KEY set in env vars');
  console.log('[capsolver] Solving challenge...');

  const createRes = await fetch('https://api.capsolver.com/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: CAPSOLVER_KEY,
      task: {
        type:       'AntiCloudflareTask',
        websiteURL: pageUrl,
        websiteKey: siteKey || '0x4AAAAAAA',
        proxy:      '',
      }
    })
  });
  const createData = await createRes.json();
  if (createData.errorId) throw new Error(`Capsolver: ${createData.errorDescription}`);
  const taskId = createData.taskId;
  console.log(`[capsolver] Task: ${taskId}`);

  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const res  = await fetch('https://api.capsolver.com/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: CAPSOLVER_KEY, taskId })
    });
    const data = await res.json();
    if (data.status === 'ready') {
      console.log('[capsolver] ✅ Solved');
      return data.solution;
    }
    console.log(`[capsolver] Waiting... ${i + 1}/24`);
  }
  throw new Error('Capsolver timeout');
}

// ── FETCH ORDER BY PAGE INTERCEPTION ─────────────────────────────────────────
async function fetchOrderByPage(orderId, shareCode) {
  const browser = await getBrowser();
  const page    = await browser.newPage();
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
      console.log('[browser] Cloudflare challenge — calling Capsolver...');

      const siteKey = await page.evaluate(() => {
        const el = document.querySelector('[data-sitekey]');
        return el ? el.getAttribute('data-sitekey') : null;
      }).catch(() => null);
      console.log(`[browser] Sitekey: ${siteKey || 'not found'}`);

      const solution = await solveTurnstile(trackingUrl, siteKey);

      if (solution?.token) {
        await page.evaluate((token) => {
          const input = document.querySelector('[name="cf-turnstile-response"]') ||
                        document.querySelector('input[type="hidden"]');
          if (input) input.value = token;
          const form = document.querySelector('form');
          if (form) form.submit();
        }, solution.token);
        await page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }).catch(() => {});
        console.log(`[browser] Post-solve title: ${await page.title()}`);
      }

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
