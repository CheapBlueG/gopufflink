const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const puppeteer = require('puppeteer-core');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

const BD_WS = process.env.BRIGHTDATA_WS || '';

if (BD_WS) console.log('✅ Bright Data Scraping Browser configured');
else        console.warn('⚠️  No BRIGHTDATA_WS set');

// ── FETCH ORDER BY INTERCEPTING GOPUFF'S OWN API CALLS ────────────────────────
// Connect to Bright Data's remote browser (residential IP + Cloudflare bypass)
// Navigate to the real GoPuff tracking page — their JS makes the API calls
// We intercept the responses. No local browser, no proxy needed on our server.
async function fetchOrderByPage(orderId, shareCode) {
  if (!BD_WS) throw new Error('BRIGHTDATA_WS env var not set');

  console.log('[bd] Connecting to Scraping Browser...');
  const browser = await puppeteer.connect({ browserWSEndpoint: BD_WS });
  console.log('[bd] ✅ Connected');

  const page = await browser.newPage();
  let orderData   = null;
  let productData = null;

  // Intercept GoPuff's own GraphQL responses
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
  console.log(`[bd] Loading ${trackingUrl}`);

  try {
    await page.goto(trackingUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    const title = await page.title();
    console.log(`[bd] Title: ${title}`);

    // Wait for GoPuff's JS to complete API calls
    await new Promise(r => setTimeout(r, 6000));
    console.log(`[bd] Order: ${orderData ? '✅' : '❌'}`);
  } catch(e) {
    console.warn('[bd] Error:', e.message);
  } finally {
    await page.close();
    await browser.disconnect(); // disconnect, not close — keeps BD session pool alive
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
});
