const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SCRAPER_SECRET || 'changeme123';

app.use(cors());
app.use(express.json());

// ── DATA STORE ────────────────────────────────────────────────────────────────
const STORE_DIR   = process.env.RENDER ? '/data' : __dirname;
const CACHE_FILE  = path.join(STORE_DIR, 'order-cache.json');

// Load persisted order cache from disk
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      console.log(`[cache] Loaded ${Object.keys(raw).length} cached orders`);
      return new Map(Object.entries(raw));
    }
  } catch(e) {}
  return new Map();
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(orderCache)), 'utf8');
  } catch(e) { console.error('[cache] Save failed:', e.message); }
}

const orderCache = loadCache();
const pending    = new Map();

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

  // Also return in-transit orders for live location updates
  const active = [...orderCache.entries()]
    .filter(([, v]) => {
      const phase = v.order?.data?.orderProgress?.phase;
      return phase === 'InTransit' || phase === 'OutForDelivery' || phase === 'Packing';
    })
    .map(([key]) => {
      const [orderId, shareCode] = key.split(':');
      return { orderId, shareCode };
    });

  res.json({ orders, active });
});

// Reverse geocode lat/lng → address string
async function reverseGeocode(lat, lng) {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
      { headers: { 'User-Agent': 'GoPuffTracker/1.0' } }
    );
    const d = await r.json();
    const a = d.address || {};
    const line1 = [a.house_number, a.road].filter(Boolean).join(' ');
    const line2 = [a.city || a.town || a.village, a.state, a.postcode].filter(Boolean).join(', ');
    return [line1, line2].filter(Boolean).join(', ');
  } catch(e) { return null; }
}

// Local scraper pushes scraped data here
app.post('/api/push', async (req, res) => {
  if (req.headers['x-secret'] !== SECRET) return res.status(401).json({ error: 'unauthorized' });
  const { orderId, shareCode, order, products } = req.body;
  const key = `${orderId}:${shareCode}`;

  // Merge with existing cache (order and products may arrive separately)
  const existing = orderCache.get(key) || {};
  const updated  = {
    order:    order    || existing.order,
    products: products || existing.products,
    address:  existing.address,
    ts:       Date.now(),
  };

  // Reverse geocode on first order push
  if (order && !existing.address) {
    const dest = order?.data?.orderProgress?.destination;
    if (dest?.latitude && dest?.longitude) {
      updated.address = await reverseGeocode(dest.latitude, dest.longitude);
      console.log(`[push] Address: ${updated.address}`);
    }
  }

  orderCache.set(key, updated);
  pending.delete(key);
  saveCache();
  console.log(`[push] ✅ ${orderId} — order:${!!updated.order} products:${!!updated.products}`);
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
  res.json({
    url: entry.gopuffUrl,
    orderId: entry.orderId,
    shareCode: entry.shareCode,
    last4: entry.last4 || null,
    apt: entry.apt || null,
  });
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
