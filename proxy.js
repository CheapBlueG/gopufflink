/**
 * GoPuff Tracker Proxy
 * ─────────────────────────────────────────────────
 * npm install express hpagent node-fetch cors
 * node proxy.js
 * ─────────────────────────────────────────────────
 */

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const { HttpsProxyAgent } = require('hpagent');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// ── RESIDENTIAL PROXY ─────────────────────────────────────────────────────────
const PROXY_USER = process.env.PROXY_USER || 'f2813c73';
const PROXY_PASS = process.env.PROXY_PASS || 'a5ac849ba05a';
const PROXY_HOST = process.env.PROXY_HOST || '38.129.182.103:23683';

const agent = new HttpsProxyAgent({
  proxy: `http://${PROXY_USER}:${PROXY_PASS}@${PROXY_HOST}`,
});

// ── GOPUFF GRAPHQL CONSTANTS ──────────────────────────────────────────────────
const GQL = 'https://www.gopuff.com/graphql';

const HASH_ORDER    = '2255154c1b1c39ec15f48cbbe9034ac51df4060a71be751e75eaabe9c287e66fd8';
const HASH_PRODUCTS = '05f6be4b25f1fc8c6e8bcf89f51f00bcc3e4dade63875d33cd3f6bc5ca0e9c87';

// ── BEARER TOKEN ──────────────────────────────────────────────────────────────
// Set GOPUFF_BEARER in Render environment variables.
// To get a fresh token: open any GoPuff tracking page → DevTools → Network →
// any /graphql request → copy the Authorization header value (without "Bearer ")
let BEARER = process.env.GOPUFF_BEARER || 'eyJraWQiOiJzaG9ydC1saXZlZCIsImFsZyI6IkVTMjU2In0.eyJzdWIiOiJnb3B1ZmYtZ3Vlc3R8cTBJSThkbmJmYnJKcDFNekJiSmsiLCJhdWQiOiJnaW0iLCJzY29wZSI6Imd1ZXN0IiwiaXNzIjoiaHR0cHM6Ly9pZGVudGl0eS5nb3B1ZmYuY29tIiwiZXhwIjoxNzc5MzMzMzAzLCJpYXQiOjE3Nzg3Mjg1MDMsImh0dHBzOi8vd3d3LmdvcHVmZi5jb20vdXNlcl9pZCI6ImdpbS12MS1xMElJOGRuYmZickpwMU16QmJKayJ9.N6aqXIG54H7YfwI-gJ5jtxdMYcc2yElay1BYsU71RBzRjgrXi8avksU7zUQR7558IwqIpcH6TA3ZB-vUSBFj8g';

// Auto-refresh guest token — tries two methods in order:
//   1. Hit GoPuff's homepage and extract the guest token from Set-Cookie header
//   2. Call the identity service directly
// If both fail, keeps the existing token until it fully expires.
async function refreshGuestToken() {
  console.log('[token] Attempting auto-refresh...');

  // ── Method 1: Extract from GoPuff homepage cookie ─────────────────────────
  // GoPuff sets `guest_token={"accessToken":"eyJ..."}` as a cookie on every
  // page load for unauthenticated visitors — no credentials needed.
  try {
    const r = await fetch('https://www.gopuff.com/go/order-tracker', {
      agent,
      headers: {
        'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
        'Accept':           'text/html,application/xhtml+xml',
        'Accept-Language':  'en-US,en;q=0.9',
        'x-gopuff-client-platform': 'web',
      },
    });

    const rawCookies = r.headers.raw?.()?.['set-cookie'] || [];
    const cookieStr  = Array.isArray(rawCookies) ? rawCookies.join('; ') : String(rawCookies);

    // GoPuff sets guest_token=<url-encoded JSON>
    const match = cookieStr.match(/guest_token=([^;]+)/);
    if (match) {
      const parsed = JSON.parse(decodeURIComponent(match[1]));
      if (parsed?.accessToken) {
        BEARER = parsed.accessToken;
        console.log('[token] ✅ Auto-refreshed via homepage cookie');
        // Optionally update Render env var automatically (see below)
        await updateRenderEnvVar(BEARER);
        return;
      }
    }
  } catch (e) {
    console.warn('[token] Method 1 failed:', e.message);
  }

  // ── Method 2: GoPuff identity service ────────────────────────────────────
  try {
    const r = await fetch('https://identity.gopuff.com/connect/token', {
      method: 'POST',
      agent,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':   'Mozilla/5.0 (compatible)',
        'x-gopuff-client-platform': 'web',
        'x-gopuff-version': '12005030',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope:      'guest',
        client_id:  'gim',
      }).toString(),
    });
    if (r.ok) {
      const data = await r.json();
      if (data?.access_token) {
        BEARER = data.access_token;
        console.log('[token] ✅ Auto-refreshed via identity service');
        await updateRenderEnvVar(BEARER);
        return;
      }
    }
  } catch (e) {
    console.warn('[token] Method 2 failed:', e.message);
  }

  console.warn('[token] ⚠️  Auto-refresh failed — keeping existing token');
}

// ── AUTO-UPDATE RENDER ENV VAR ────────────────────────────────────────────────
// When a new token is fetched, push it to Render so it survives redeploys.
// Set RENDER_API_KEY and RENDER_SERVICE_ID in your Render environment variables.
async function updateRenderEnvVar(newToken) {
  const apiKey    = process.env.RENDER_API_KEY;
  const serviceId = process.env.RENDER_SERVICE_ID;
  if (!apiKey || !serviceId) return; // skip if not configured

  try {
    await fetch(`https://api.render.com/v1/services/${serviceId}/env-vars`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify([{ key: 'GOPUFF_BEARER', value: newToken }]),
    });
    console.log('[token] ✅ Updated GOPUFF_BEARER on Render');
  } catch (e) {
    console.warn('[token] Render env update failed:', e.message);
  }
}

// Check token expiry every hour; refresh 1 hour before expiry
function scheduleTokenRefresh() {
  try {
    const payload = JSON.parse(Buffer.from(BEARER.split('.')[1], 'base64').toString());
    const expiresMs = payload.exp * 1000;
    const refreshMs = expiresMs - Date.now() - 3600_000; // 1 hr before expiry
    if (refreshMs > 0) {
      console.log(`[token] Refreshing in ${Math.round(refreshMs/60000)} min`);
      setTimeout(async () => { await refreshGuestToken(); scheduleTokenRefresh(); }, refreshMs);
    } else {
      console.log('[token] Token expired or expiring soon — refreshing now');
      refreshGuestToken().then(scheduleTokenRefresh);
    }
  } catch (e) {
    console.warn('[token] Could not parse token expiry:', e.message);
  }
}

// ── BASE HEADERS (matching what the browser sends) ────────────────────────────
const HEADERS = () => ({
  'Accept':                   'application/graphql+json, application/json',
  'Accept-Language':          'en-US',
  'Authorization':            `Bearer ${BEARER}`,
  'User-Agent':               'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  'x-gopuff-client-platform': 'web',
  'x-gopuff-client-version':  '12.5.30-193096',
  'x-gopuff-version':         '12005030',
  'x-gp-point-of-sale':       'US',
  'sec-fetch-dest':           'empty',
  'sec-fetch-mode':           'cors',
  'sec-fetch-site':           'same-origin',
});

// ── GRAPHQL GET HELPER ────────────────────────────────────────────────────────
async function gqlGet(operationName, variables, hash) {
  const v = encodeURIComponent(JSON.stringify(variables));
  const e = encodeURIComponent(JSON.stringify({
    persistedQuery: { sha256Hash: hash, version: 1 },
  }));
  const url = `${GQL}?operationName=${operationName}&variables=${v}&extensions=${e}`;

  const r = await fetch(url, { agent, headers: HEADERS() });

  if (r.status === 401) {
    // Token expired mid-session — refresh and retry once
    await refreshGuestToken();
    const r2 = await fetch(url, { agent, headers: HEADERS() });
    if (!r2.ok) throw new Error(`GoPuff ${r2.status} after token refresh`);
    return r2.json();
  }

  if (!r.ok) throw new Error(`GoPuff ${r.status}: ${r.statusText}`);
  return r.json();
}

// ── ROUTE: GET /api/track ──────────────────────────────────────────────────────
// Query params: orderId, shareCode
// Both come from the GoPuff tracking URL — see tracker HTML for extraction logic
app.get('/api/track', async (req, res) => {
  const { orderId, shareCode } = req.query;
  if (!orderId || !shareCode) {
    return res.status(400).json({ error: 'orderId and shareCode are required' });
  }
  try {
    const data = await gqlGet(
      'GetSharedOrderStatus',
      { orderId, shareCode },
      HASH_ORDER
    );
    res.json(data);
  } catch (e) {
    console.error('[/api/track]', e.message);
    res.status(502).json({ error: e.message });
  }
});

const HASH_CHAT_STREAM = '8750177ac802f7020af237cc238940ecb8c54d8ee03e4e3fb8e6e7e28f00fafa';

// ── ROUTE: GET /api/stream ────────────────────────────────────────────────────
// Fetches the real-time SSE stream URL from GoPuff, then pipes it to the client.
// Frontend connects via EventSource('/api/stream') and gets instant driver location
// pushes instead of polling every 5s.
//
// GoPuff pushes events to: ops-notifications-api.delivery-tech.gopuff.com/customer/chat-events/stream
// Auth is via Bearer token — same guest JWT used for all other calls.
app.get('/api/stream', async (req, res) => {
  try {
    // Step 1: Ask GoPuff for the stream URL
    const data = await gqlGet('GetChatEventsStream', {}, HASH_CHAT_STREAM);
    const streamUrl = data?.data?.getChatEventStream?.url;
    if (!streamUrl) throw new Error('GoPuff returned no stream URL');

    console.log('[/api/stream] Connecting to:', streamUrl);

    // Step 2: Open SSE connection to GoPuff's stream
    const upstream = await fetch(streamUrl, {
      agent,
      headers: {
        ...HEADERS(),
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    });

    if (!upstream.ok) throw new Error(`Stream upstream ${upstream.status}`);

    // Step 3: Forward SSE stream to our client
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();

    // Clean up when client disconnects
    req.on('close', () => {
      console.log('[/api/stream] Client disconnected, closing upstream');
      reader.cancel();
    });

    // Pipe GoPuff → client
    while (true) {
      const { done, value } = await reader.read();
      if (done) { res.end(); break; }
      const chunk = decoder.decode(value, { stream: true });
      res.write(chunk);
    }
  } catch (e) {
    console.error('[/api/stream]', e.message);
    // Send a comment so the client knows to fall back to polling
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.flushHeaders();
    }
    res.write(': stream-error\n\n');
    res.end();
  }
});

// ── ROUTE: GET /api/estimate ───────────────────────────────────────────────────
// Query params: zoneId, lat, lng
// Returns { from, to } in minutes — shown as "20–35 min" ETA range
// Uses destination lat/lng from the order response
app.get('/api/estimate', async (req, res) => {
  const { zoneId, lat, lng } = req.query;
  if (!zoneId || !lat || !lng) {
    return res.status(400).json({ error: 'zoneId, lat, lng required' });
  }
  try {
    const data = await gqlGet(
      'DeliveryEstimate',
      {
        deliveryZoneId: Number(zoneId),
        fastestAvailable: true,
        isDeferred: false,
        latlng: { lat: Number(lat), lng: Number(lng) },
        products: [],
      },
      'dcfca9ce9b6183627fc3cd0d6936716fea8165695ae8e5b375abb050609a7b91'
    );
    // Flatten to { from, to, priority }
    const est = data?.data?.view?.deliveryEstimate || {};
    res.json({ from: est.from, to: est.to, priority: est.priority });
  } catch (e) {
    console.error('[/api/estimate]', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── ROUTE: GET /api/products ───────────────────────────────────────────────────
// Query param: ids  (comma-separated list of product IDs)
// Returns data.view.products[] with title, tileImages, price, brand, sizeWithPack
app.get('/api/products', async (req, res) => {
  const raw = req.query.ids || '';
  const productIds = [...new Set(raw.split(',').map(Number).filter(Boolean))]; // deduplicate
  if (productIds.length === 0) {
    return res.status(400).json({ error: 'ids param required' });
  }
  try {
    const data = await gqlGet(
      'Products',
      { platform: 'WEB', productIds },
      HASH_PRODUCTS
    );
    res.json(data);
  } catch (e) {
    console.error('[/api/products]', e.message);
    res.status(502).json({ error: e.message });
  }
});

const { store } = require('./bot'); // shared tracking link store

// ── ROUTE: GET /api/resolve/:shortId ─────────────────────────────────────────
// Resolves a short tracking ID → original GoPuff URL
// Called by the tracker HTML on page load when visiting /t/:shortId
app.get('/api/resolve/:shortId', (req, res) => {
  const entry = store.get(req.params.shortId);
  if (!entry) return res.status(404).json({ error: 'Link not found or expired' });
  res.json({ url: entry.gopuffUrl });
});

// ── ROUTE: GET /t/:shortId ────────────────────────────────────────────────────
// Serves the tracker HTML — the page auto-loads the order via /api/resolve
app.get('/t/:shortId', (req, res) => {
  const entry = store.get(req.params.shortId);
  if (!entry) {
    return res.status(404).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#07080d;color:#fff">
        <h2>❌ Link not found</h2>
        <p style="color:#9ca3af">This tracking link has expired or doesn't exist.</p>
      </body></html>
    `);
  }
  // Serve the tracker — it will call /api/resolve on load
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── SERVE TRACKER UI ──────────────────────────────────────────────────────────
app.use(express.static('public')); // put gopuff-tracker.html in ./public/index.html

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`✅ GoPuff proxy running → http://localhost:${PORT}`);
  scheduleTokenRefresh();
});

module.exports = { refreshGuestToken };
