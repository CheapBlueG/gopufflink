/**
 * GoPuff Tracker — Telegram Bot
 * ─────────────────────────────────────────────────
 * npm install node-telegram-bot-api
 * node bot.js
 * ─────────────────────────────────────────────────
 */

const TelegramBot = require('node-telegram-bot-api');
const crypto      = require('crypto');
const fs          = require('fs');
const path        = require('path');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const TOKEN    = process.env.TELEGRAM_TOKEN || '8813216545:AAGPM3kvZLYDHPXvJiNIS30Ah3CmMaDhYZA';
const BASE_URL = process.env.BASE_URL       || 'https://groceriesarecool.com';
// On Render: stored on persistent disk at /data (configured in render.yaml)
// Locally: stored next to bot.js
const STORE_DIR  = process.env.NODE_ENV === 'production' ? '/data' : __dirname;
const STORE_FILE = path.join(STORE_DIR, 'tracking-store.json');

// ── PERSISTENT STORE ──────────────────────────────────────────────────────────
// Loads from disk so links survive proxy restarts
function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      return new Map(Object.entries(JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))));
    }
  } catch(e) {}
  return new Map();
}

function saveStore() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(Object.fromEntries(store)), 'utf8');
  } catch(e) { console.error('[store] Save failed:', e.message); }
}

const store = loadStore();
console.log(`[store] Loaded ${store.size} existing tracking links`);

// ── HELPERS ───────────────────────────────────────────────────────────────────
function generateShortId() {
  // e.g. "a3f9c1b2" — 8 chars, URL-safe
  return crypto.randomBytes(4).toString('hex');
}

function isGoPuffUrl(text) {
  return /gopuff\.com.*(order-tracker|track)/i.test(text);
}

// ── BOT ───────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });

console.log('🤖 GoPuff Tracker Bot is running...');

// /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `👋 *Welcome to GoPuff Tracker!*\n\n` +
    `Send me a GoPuff tracking link and I'll generate a live tracking page for you.\n\n` +
    `📦 Example:\n` +
    "`gopuff.com/go/order-tracker?orderId=123&shareCode=ABC`\n\n" +
    `Your clients will get a sleek real-time map showing the driver, ETA, and full order.`,
    { parse_mode: 'Markdown' }
  );
});

// /help
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `*How to use:*\n\n` +
    `1. Get your GoPuff tracking URL (from confirmation SMS or email)\n` +
    `2. Send it here\n` +
    `3. Forward the link I give you to your client\n\n` +
    `*Commands:*\n` +
    `/start — Welcome message\n` +
    `/links — Show all active tracking links\n` +
    `/help  — This message`,
    { parse_mode: 'Markdown' }
  );
});

// /links — show all stored links
bot.onText(/\/links/, (msg) => {
  if (store.size === 0) {
    bot.sendMessage(msg.chat.id, '📭 No active tracking links yet.');
    return;
  }
  const lines = [...store.entries()].slice(-10).map(([id, entry]) =>
    `• \`${BASE_URL}/t/${id}\`\n  _${new Date(entry.createdAt).toLocaleString()}_`
  );
  bot.sendMessage(msg.chat.id,
    `*Active Tracking Links (last 10):*\n\n${lines.join('\n\n')}`,
    { parse_mode: 'Markdown' }
  );
});

// Handle any message — if it looks like a GoPuff URL, generate a link
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text   = msg.text?.trim();

  if (!text || text.startsWith('/')) return;

  if (!isGoPuffUrl(text)) {
    bot.sendMessage(chatId,
      `❌ That doesn't look like a GoPuff tracking link.\n\n` +
      `Send me something like:\n\`gopuff.com/go/order-tracker?orderId=123&shareCode=ABC\``,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Show typing indicator
  bot.sendChatAction(chatId, 'typing');

  // Check if we already made a link for this exact URL
  const existing = [...store.entries()].find(([, v]) => v.gopuffUrl === text);
  if (existing) {
    const [id] = existing;
    bot.sendMessage(chatId,
      `♻️ *Link already exists for this order:*\n\n` +
      `🔗 \`${BASE_URL}/t/${id}\`\n\n` +
      `_Share this with your client for live tracking._`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Generate unique short ID
  let shortId;
  do { shortId = generateShortId(); } while (store.has(shortId));

  // Store it
  store.set(shortId, {
    gopuffUrl:  text,
    chatId,
    createdAt:  Date.now(),
  });
  saveStore();

  const trackUrl = `${BASE_URL}/t/${shortId}`;

  bot.sendMessage(chatId,
    `✅ *Live tracking link created!*\n\n` +
    `🔗 \`${trackUrl}\`\n\n` +
    `Share this with your client — they'll see:\n` +
    `• 📍 Live driver location on a map\n` +
    `• 📦 Full order with product images\n` +
    `• ⏱ Real-time ETA\n` +
    `• ✅ Delivery status updates\n\n` +
    `_Link is ready immediately._`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🔗 Open Tracker', url: trackUrl },
          { text: '📋 Copy Link', callback_query_id: shortId, callback_data: `copy:${shortId}` }
        ]]
      }
    }
  );
});

// Callback for inline button
bot.on('callback_query', (query) => {
  if (query.data?.startsWith('copy:')) {
    const id = query.data.split(':')[1];
    const url = `${BASE_URL}/t/${id}`;
    bot.answerCallbackQuery(query.id, { text: `Link: ${url}`, show_alert: true });
  }
});

bot.on('polling_error', (err) => {
  console.error('[telegram]', err.message);
});

// Export store so proxy.js can resolve shortIds
module.exports = { store };
