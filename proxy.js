/**
 * GoPuff Tracker — Server
 * All GoPuff API calls happen client-side (user's residential IP bypasses Cloudflare)
 * Server only: serves the tracker page, resolves short links, runs the Telegram bot
 */

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// ── SHARED STORE (from bot.js) ─────────────────────────────────────────────────
const { store } = require('./bot');

// ── ROUTES ────────────────────────────────────────────────────────────────────

// Resolve short link → original GoPuff URL + parsed orderId/shareCode
app.get('/api/resolve/:shortId', (req, res) => {
  const entry = store.get(req.params.shortId);
  if (!entry) return res.status(404).json({ error: 'Link not found or expired' });
  res.json({
    url:       entry.gopuffUrl,
    orderId:   entry.orderId,
    shareCode: entry.shareCode,
  });
});

// Short link → serve tracker page
app.get('/:shortId([a-f0-9]{8})', (req, res) => {
  const entry = store.get(req.params.shortId);
  if (!entry) {
    return res.status(404).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#07080d;color:#fff">
        <h2>❌ Link not found</h2>
        <p style="color:#9ca3af">This tracking link has expired or doesn't exist.</p>
      </body></html>`);
  }
  res.sendFile(path.join(__dirname, 'gopuff-tracker.html'));
});

// Serve static files
app.use(express.static(__dirname));

// ── START ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
