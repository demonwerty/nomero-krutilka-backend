/**
 * Номеро-Крутилка — Telegram Stars Backend
 *
 * Деплой:
 *   Render / Railway / VPS (Node 18+):
 *     npm init -y
 *     npm i express
 *     BOT_TOKEN=xxxx node server.js
 *
 *   Vercel (serverless):
 *     оберните endpoints в /api/create-invoice.js и /api/webhook.js
 *     или используйте @vercel/node — код совместим, app.listen можно убрать.
 *
 * Переменные окружения:
 *   BOT_TOKEN      — токен бота от @BotFather (обязательно)
 *   WEBHOOK_SECRET — секрет для X-Telegram-Bot-Api-Secret-Token (опционально)
 *   PORT           — порт (по умолчанию 3000)
 */

const express = require('express');
const app = express();
app.use(express.json({ limit: '256kb' }));

const BOT_TOKEN      = process.env.BOT_TOKEN || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

// ─────────────────────────────────────────────────────────────
//  8 ТОВАРОВ (цены в Stars / XTR)
// ─────────────────────────────────────────────────────────────
const PRODUCTS = {
  starter_pack:   { title: 'Стартовый набор',     description: '500 💎 + 100 000 💵 + рамка «Неон»',   price: 150 },
  season_premium: { title: 'Сезонный пропуск',    description: 'Премиум-трек текущего сезона',          price: 250 },
  cyber_phantom:  { title: 'Cyber-Phantom',       description: 'Эксклюзивный гиперкар ×5 к доходу',    price: 600 },
  lucky_talisman: { title: 'Талисман удачи',      description: '×2 к шансу редких номеров и критам',   price: 500 },
  vip_garage:     { title: 'VIP-статус',          description: '×2 к пассивному доходу гаража',        price: 400 },
  gems_500:       { title: 'Мешок кристаллов',    description: '500 кристаллов',                        price: 100 },
  garage_slot:    { title: 'Машиноместо +1',      description: 'Дополнительное место в гараже',         price: 100 },
  time_accel:     { title: 'Ускоритель Времени',  description: '12 часов дохода вашего гаража',         price: 75  },
};

// ─────────────────────────────────────────────────────────────
//  In-memory хранилище
//  ⚠️  На Vercel Serverless не персистится между вызовами!
//  Для продакшена → Vercel KV / Upstash Redis / Supabase.
// ─────────────────────────────────────────────────────────────
const pendingInvoices = new Map(); // payload → { userId, productId, createdAt }
const paidProducts    = new Map(); // `${userId}:${productId}` → { paidAt, chargeId, amount, payload }

// ─────────────────────────────────────────────────────────────
//  Telegram Bot API helper
// ─────────────────────────────────────────────────────────────
async function tgApi(method, params) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return r.json();
}

// ─────────────────────────────────────────────────────────────
//  POST /api/create-invoice
//  { user_id, productId } → { invoice_url }
// ─────────────────────────────────────────────────────────────
app.post('/api/create-invoice', async (req, res) => {
  try {
    if (!BOT_TOKEN) {
      return res.status(500).json({ error: 'Server misconfigured: BOT_TOKEN missing' });
    }
    const { user_id, productId } = req.body || {};
    if (!user_id || !productId) {
      return res.status(400).json({ error: 'user_id и productId обязательны' });
    }
    const product = PRODUCTS[productId];
    if (!product) {
      return res.status(400).json({ error: 'Unknown productId' });
    }

    const payload = `${user_id}:${productId}:${Date.now()}`;

    const data = await tgApi('createInvoiceLink', {
      title: product.title,
      description: product.description,
      payload,
      provider_token: '',           // для Stars — пустой
      currency: 'XTR',              // Telegram Stars
      prices: [{ label: product.title, amount: product.price }],
    });

    if (!data.ok) {
      console.error('createInvoiceLink error:', data);
      return res.status(502).json({ error: data.description || 'Telegram API error' });
    }

    pendingInvoices.set(payload, {
      userId: String(user_id),
      productId,
      createdAt: Date.now(),
    });

    res.json({ invoice_url: data.result, payload });
  } catch (e) {
    console.error('create-invoice error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /api/webhook  ← сюда приходят pre_checkout_query и successful_payment
// ─────────────────────────────────────────────────────────────
app.post('/api/webhook', async (req, res) => {
  try {
    if (WEBHOOK_SECRET) {
      const got = req.get('X-Telegram-Bot-Api-Secret-Token');
      if (got !== WEBHOOK_SECRET) {
        return res.status(401).json({ error: 'Invalid secret' });
      }
    }

    const update = req.body || {};

    // 1) Pre-checkout — обязательный OK, иначе оплата не пройдёт
    if (update.pre_checkout_query) {
      await tgApi('answerPreCheckoutQuery', {
        pre_checkout_query_id: update.pre_checkout_query.id,
        ok: true,
      });
      return res.json({ ok: true });
    }

    // 2) Оплата прошла
    if (update.message && update.message.successful_payment) {
      const sp = update.message.successful_payment;
      const [userId, productId] = String(sp.invoice_payload || '').split(':');
      const key = `${userId}:${productId}`;

      paidProducts.set(key, {
        paidAt:   Date.now(),
        chargeId: sp.telegram_payment_charge_id,
        amount:   sp.total_amount,
        currency: sp.currency,
        payload:  sp.invoice_payload,
      });

      const pending = pendingInvoices.get(sp.invoice_payload);
      if (pending) pending.paid = true;

      console.log(`💰 PAID: user=${userId} product=${productId} amount=${sp.total_amount} ${sp.currency}`);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('webhook error:', e);
    res.status(500).json({ error: 'Webhook error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /api/payment-status  — проверка статуса оплаты
// ─────────────────────────────────────────────────────────────
app.get('/api/payment-status', (req, res) => {
  const { user_id, productId } = req.query;
  if (!user_id || !productId) {
    return res.status(400).json({ error: 'user_id и productId обязательны' });
  }
  const rec = paidProducts.get(`${user_id}:${productId}`);
  if (rec) return res.json({ paid: true, ...rec });
  return res.json({ paid: false });
});

// ─────────────────────────────────────────────────────────────
//  GET /api/products — публичный список товаров (для сверки цен)
// ─────────────────────────────────────────────────────────────
app.get('/api/products', (req, res) => res.json(PRODUCTS));

// ─────────────────────────────────────────────────────────────
//  GET /api/set-webhook?url=https://your-server.com
//  Одноразово вызывается после деплоя — регистрирует вебхук.
// ─────────────────────────────────────────────────────────────
app.get('/api/set-webhook', async (req, res) => {
  try {
    const base = req.query.url;
    if (!base) return res.status(400).json({ error: 'url обязателен' });

    const params = { url: base.replace(/\/$/, '') + '/api/webhook' };
    if (WEBHOOK_SECRET) params.secret_token = WEBHOOK_SECRET;
    if (req.query.drop_pending) params.drop_pending_updates = true;

    const data = await tgApi('setWebhook', params);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─────────────────────────────────────────────────────────────
//  Health-check + запуск
// ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ ok: true, service: 'nomero-krutilka-stars' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
  if (!BOT_TOKEN) console.warn('⚠️  BOT_TOKEN не задан — установите переменную окружения!');
});

module.exports = app;