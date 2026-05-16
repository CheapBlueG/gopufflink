const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SCRAPER_SECRET || 'changeme123';

app.use(cors());
app.use(express.json());

// ── DATA STORE ────────────────────────────────────────────────────────────────
// Order data pushed from local scraper, served to clients
const orderCache = new Map(); // orderId:shareCode → { order, products, ts }
const pending    = new Map(); // orderId:shareCode → true (waiting to be scraped)

// ── SHARED STORE (bot links) ──────────────────────────────────────────────────
const { store } = require('./bot');

// ── ROUTES ────────────────────────────────────────────────────────────────────

// Local scraper polls this for new orders to scrape
app.get('/api/pending', (req, res) => {
  if (req.query.secret !== SECRET) return res.status(401).json({ error: 'unauthorized' });
  const orders = [...pending.entries()].map(([key]) => {
    const [orderId, shareCode] = key.split(':');
    return { orderId, shareCode };
  });
  res.json({ orders });
});

// Local scraper pushes scraped data here
app.post('/api/push', (req, res) => {
  if (req.headers['x-secret'] !== SECRET) return res.status(401).json({ error: 'unauthorized' });
  const { orderId, shareCode, order, products } = req.body;
  const key = `${orderId}:${shareCode}`;
  orderCache.set(key, { order, products, ts: Date.now() });
  pending.delete(key);
  console.log(`[push] ✅ Order ${orderId} data received from local scraper`);
  res.json({ ok: true });
});

// Client requests order data
app.get('/api/track', (req, res) => {
  const { orderId, shareCode } = req.query;
  if (!orderId || !shareCode) return res.status(400).json({ error: 'orderId and shareCode required' });

  const key    = `${orderId}:${shareCode}`;
  const cached = orderCache.get(key);

  if (cached) {
    console.log(`[track] ✅ Serving cached data for ${orderId}`);
    return res.json(cached);
  }

  // Queue for scraping
  pending.set(key, true);
  console.log(`[track] ⏳ Order ${orderId} queued for scraping`);

  // Return loading state so client can poll
  res.status(202).json({ status: 'loading', message: 'Order is being fetched — refresh in 15 seconds' });
});

// Resolve short link
app.get('/api/resolve/:shortId', (req, res) => {
  const entry = store.get(req.params.shortId);
  if (!entry) return res.status(404).json({ error: 'Link not found' });
  res.json({ url: entry.gopuffUrl, orderId: entry.orderId, shareCode: entry.shareCode });
});

// Legacy redirect
app.get('/t/:shortId', (req, res) => res.redirect(301, `/${req.params.shortId}`));

// Short link → tracker page
app.get('/:shortId([a-f0-9]{8})', (req, res) => {
  if (!store.get(req.params.shortId)) {
    return res.status(404).send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#07080d;color:#fff"><h2>❌ Link not found</h2></body></html>`);
  }
  res.sendFile(path.join(__dirname, 'gopuff-tracker.html'));
});

app.use(express.static(__dirname));

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
