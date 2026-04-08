require('dotenv').config();
const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cbqrhwgzzkoqgicxvvdr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // service role key — set in .env, never hardcode
if (!SUPABASE_KEY) { console.error('SUPABASE_SERVICE_KEY is not set'); process.exit(1); }
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

const SOL_WALLET = 'A8HSniSFHofGiQUQwcmgRsaCJq6NM9B2zj4XM4pysYRY';
const USDT_MINT  = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'; // USDT on Solana

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

async function confirmOrder(coin, amountReceived) {
  const { data: orders, error } = await db
    .from('orders')
    .select('*')
    .eq('status', 'pending')
    .eq('coin', coin);

  if (error || !orders?.length) return;

  const matched = orders.find(o => {
    const diff = Math.abs(parseFloat(o.amount_crypto) - amountReceived) / parseFloat(o.amount_crypto);
    return diff < 0.0005; // 0.05% — tight enough to uniquely match dust-offset orders
  });

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
  res.sendStatus(200); // always respond fast to Helius

  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];

    for (const event of events) {
      // Native SOL transfers
      for (const transfer of (event.nativeTransfers || [])) {
        if (transfer.toUserAccount !== SOL_WALLET) continue;
        const amountSOL = transfer.amount / 1e9;
        console.log(`Incoming SOL: ${amountSOL}`);
        await confirmOrder('sol', amountSOL);
      }

      // USDT (SPL token) transfers
      for (const transfer of (event.tokenTransfers || [])) {
        if (transfer.toUserAccount !== SOL_WALLET) continue;
        if (transfer.mint !== USDT_MINT) continue;
        const amountUSDT = transfer.tokenAmount; // already human-readable
        console.log(`Incoming USDT: ${amountUSDT}`);
        await confirmOrder('usdt', amountUSDT);
      }
    }
  } catch (err) {
    console.error('Webhook error:', err);
  }
});

const PLAN_LIMITS = { Starter: 1, Pro: 2, Lifetime: 5 };

// License key validation + IP registration
app.post('/check-license', async (req, res) => {
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

function generateKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusable chars
  const seg = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `LARP-${seg()}-${seg()}-${seg()}-${seg()}`;
}

app.listen(PORT, () => {
  console.log(`larpify running at http://localhost:${PORT}`);
});
