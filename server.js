require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cbqrhwgzzkoqgicxvvdr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // service role key — set in .env, never hardcode
if (!SUPABASE_KEY) { console.error('SUPABASE_SERVICE_KEY is not set'); process.exit(1); }
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

const SOL_WALLET = 'A8HSniSFHofGiQUQwcmgRsaCJq6NM9B2zj4XM4pysYRY';
const USDT_MINT  = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'; // USDT on Solana

// Promo codes — add or remove codes here, discount is a percentage
const PROMO_CODES = {
  'VICTKRR': { discount: 20 }
};

const PLAN_PRICES = { Starter: 15, Pro: 40, Lifetime: 120 };

app.use((req, res, next) => {
  const allowed = ['https://www.getlarpify.com', 'https://app.getlarpify.com'];
  const origin = req.headers.origin;
  if (allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/webhook/test', (req, res) => {
  console.log('Webhook test endpoint hit');
  res.json({ ok: true, time: new Date().toISOString() });
});

async function confirmOrder(coin, amountReceived) {
  const { data: orders, error } = await db
    .from('orders')
    .select('*')
    .eq('status', 'pending')
    .eq('coin', coin);

  if (error || !orders?.length) return;

  // Pick the closest matching order (not just first within tolerance)
  let matched = null, bestDiff = Infinity;
  for (const o of orders) {
    const diff = Math.abs(parseFloat(o.amount_crypto) - amountReceived);
    if (diff < 0.001 && diff < bestDiff) { matched = o; bestDiff = diff; }
  }
  console.log(matched ? `Best match: ${matched.order_id} (diff: ${bestDiff})` : 'No match found');

  if (!matched) {
    console.log(`No matching ${coin} order for ${amountReceived}`);
    return;
  }

  const key = generateKey();
  console.log(`Match found: ${matched.order_id} → key: ${key}`);

  const { error: updateError } = await db.from('orders').update({
    status: 'paid',
    license_key: key,
    paid_at: new Date().toISOString()
  }).eq('id', matched.id);
  if (updateError) console.error('Update error:', JSON.stringify(updateError));
}

// Helius webhook — called when a transaction hits your SOL wallet
app.post('/webhook/helius', async (req, res) => {
  // Verify webhook secret so nobody can fake a payment
  const secret = process.env.HELIUS_WEBHOOK_SECRET;
  if (secret && req.headers['authorization'] !== secret) {
    console.warn('Helius webhook: unauthorized request rejected');
    return res.sendStatus(401);
  }

  res.sendStatus(200); // always respond fast to Helius

  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];

    console.log(`Helius: received ${events.length} event(s)`);

    for (const event of events) {
      console.log(`Event type: ${event.type}, nativeTransfers: ${(event.nativeTransfers||[]).length}, tokenTransfers: ${(event.tokenTransfers||[]).length}`);

      // Native SOL transfers
      for (const transfer of (event.nativeTransfers || [])) {
        console.log(`SOL transfer → toUserAccount: ${transfer.toUserAccount}, amount: ${transfer.amount}`);
        if (transfer.toUserAccount !== SOL_WALLET) {
          console.log(`Skipping — not our wallet (expected ${SOL_WALLET})`);
          continue;
        }
        const amountSOL = transfer.amount / 1e9;
        console.log(`Incoming SOL: ${amountSOL}`);
        await confirmOrder('sol', amountSOL);
      }

      // USDT (SPL token) transfers
      for (const transfer of (event.tokenTransfers || [])) {
        console.log(`Token transfer → toUserAccount: ${transfer.toUserAccount}, mint: ${transfer.mint}, amount: ${transfer.tokenAmount}`);
        if (transfer.toUserAccount !== SOL_WALLET) {
          console.log(`Skipping — not our wallet`);
          continue;
        }
        if (transfer.mint !== USDT_MINT) {
          console.log(`Skipping — wrong mint (expected ${USDT_MINT})`);
          continue;
        }
        const amountUSDT = transfer.tokenAmount;
        console.log(`Incoming USDT: ${amountUSDT}`);
        await confirmOrder('usdt', amountUSDT);
      }
    }
  } catch (err) {
    console.error('Webhook error:', err);
  }
});

const PLAN_LIMITS = { Starter: 1, Pro: 2, Lifetime: 5 };

// Simple rate limiter — max 10 requests per IP per minute on sensitive endpoints
const rateLimitMap = new Map();
function rateLimit(req, res, next) {
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  const now = Date.now();
  const windowMs = 60_000;
  const max = 10;
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > windowMs) { entry.count = 0; entry.start = now; }
  entry.count++;
  rateLimitMap.set(ip, entry);
  if (entry.count > max) return res.status(429).json({ valid: false, reason: 'Too many requests. Try again later.' });
  next();
}

// License key validation + IP registration
app.post('/check-license', rateLimit, async (req, res) => {
  const { key } = req.body;
  if (!key) return res.json({ valid: false, reason: 'No key provided' });

  const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  const { data: order, error } = await db
    .from('orders')
    .select('*')
    .eq('license_key', key)
    .eq('status', 'paid')
    .single();

  if (error || !order) return res.json({ valid: false, reason: 'Invalid license key.' });

  const maxIps = PLAN_LIMITS[order.plan] || 1;
  const ips = order.ip_addresses || [];

  // Already registered IP — allow
  if (ips.includes(ip)) return res.json({ valid: true, plan: order.plan });

  // Too many devices
  if (ips.length >= maxIps) {
    return res.json({ valid: false, reason: `This key is already active on ${maxIps} device(s). Max for ${order.plan} plan is ${maxIps}.` });
  }

  // Register new IP
  const { error: updateError } = await db
    .from('orders')
    .update({ ip_addresses: [...ips, ip] })
    .eq('id', order.id);

  if (updateError) return res.json({ valid: false, reason: 'Server error. Try again.' });

  return res.json({ valid: true, plan: order.plan });
});

// Validate a promo code
app.post('/validate-promo', rateLimit, (req, res) => {
  const { code } = req.body || {};
  if (!code || typeof code !== 'string') return res.json({ valid: false });
  const promo = PROMO_CODES[code.trim().toUpperCase()];
  if (!promo) return res.json({ valid: false });
  return res.json({ valid: true, discount: promo.discount });
});

// Create order server-side so the discount can't be faked on the client
app.post('/create-order', rateLimit, async (req, res) => {
  const { plan, coin, promo_code } = req.body || {};

  if (!PLAN_PRICES[plan]) return res.status(400).json({ error: 'Invalid plan' });
  if (!['sol', 'usdt'].includes(coin)) return res.status(400).json({ error: 'Invalid coin for automated payment' });

  let usd = PLAN_PRICES[plan];
  let appliedPromo = null;

  if (promo_code) {
    const promo = PROMO_CODES[promo_code.trim().toUpperCase()];
    if (promo) {
      usd = parseFloat((usd * (1 - promo.discount / 100)).toFixed(2));
      appliedPromo = promo_code.trim().toUpperCase();
    }
  }

  let solPrice;
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const d = await r.json();
    solPrice = d.solana.usd;
  } catch {
    return res.status(503).json({ error: 'Could not fetch live prices. Try again.' });
  }

  const rate = coin === 'usdt' ? 1 : solPrice;
  const dust = (Math.floor(Math.random() * 900) + 100) * 0.000001;
  const cryptoAmt = parseFloat(((usd / rate) + dust).toFixed(8));
  const orderId = 'ORD-' + crypto.randomBytes(16).toString('hex').toUpperCase();

  const orderRow = { order_id: orderId, plan, amount_usd: usd, amount_crypto: cryptoAmt, coin, status: 'pending' };
  if (appliedPromo) orderRow.promo_code = appliedPromo;

  const { error } = await db.from('orders').insert(orderRow);
  if (error) return res.status(500).json({ error: error.message });

  return res.json({ order_id: orderId, amount_usd: usd, amount_crypto: cryptoAmt });
});

// Promo code usage stats — protect with ADMIN_SECRET env var
app.get('/promo-stats', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (secret && req.query.secret !== secret) return res.status(403).json({ error: 'Forbidden' });

  const { data, error } = await db
    .from('orders')
    .select('promo_code, plan, amount_usd, status')
    .not('promo_code', 'is', null);

  if (error) return res.status(500).json({ error: error.message });

  const stats = {};
  for (const order of data || []) {
    const code = order.promo_code;
    if (!stats[code]) stats[code] = { uses: 0, paid: 0, revenue: 0, plans: {} };
    stats[code].uses++;
    if (order.status === 'paid') {
      stats[code].paid++;
      stats[code].revenue = parseFloat((stats[code].revenue + order.amount_usd).toFixed(2));
    }
    stats[code].plans[order.plan] = (stats[code].plans[order.plan] || 0) + 1;
  }

  return res.json(stats);
});

function generateKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusable chars
  const seg = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `LARP-${seg()}-${seg()}-${seg()}-${seg()}`;
}

app.listen(PORT, () => {
  console.log(`larpify running at http://localhost:${PORT}`);
});
