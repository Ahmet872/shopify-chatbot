const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();

// ─── PROXY & CORS & BODY ───────────────────────────────────────────────────────
// trust proxy: Render'ın load balancer'ı arkasında doğru IP'yi al (rate limit için şart).
app.set('trust proxy', 1);

// CORS: yalnızca izin verilen origin'ler. Yeni müşteri ekleyince buraya domain ekle.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Origin yoksa (curl, Postman, server-to-server) veya listede varsa izin ver.
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('CORS: izin verilmeyen origin — ' + origin));
  },
  credentials: true
}));

// Body limiti: büyük payload saldırılarını engelle.
app.use(express.json({ limit: '20kb' }));

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 dakika pencere
  max: 20,                    // IP başına dakikada max 20 istek
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Çok fazla mesaj gönderdiniz, lütfen bir dakika bekleyin.' }
});

const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,                     // Admin/lead endpoint'leri için daha sıkı
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Çok fazla istek.' }
});

const shopify = require('./shopify');
const woocommerce = require('./woocommerce');
const openai = require('./openai');
const db = require('./database');
const { buildSystemPrompt } = require("./systemprompt");

// ─── XSS KORUMASI ─────────────────────────────────────────────────────────────
// Kullanıcı/müşteri verisini doğrudan HTML'e yazmadan önce her zaman bu
// fonksiyondan geçir. store_name, first_message, session_id vb.
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}



// ─── STARTUP GÜVENLİK KONTROLÜ ───────────────────────────────────────────────
// MASTER_ADMIN_PASSWORD env'de tanımlı değilse sunucu başlamayı reddeder.
// Deploy sırasında unutulmasını önler — sessizce varsayılan şifre kullanmak
// tüm admin panelini açık bırakır.
if (!process.env.MASTER_ADMIN_PASSWORD) {
  console.error('HATA: MASTER_ADMIN_PASSWORD env değişkeni tanımlı değil!');
  console.error('Render → Environment → MASTER_ADMIN_PASSWORD ekleyin ve yeniden deploy edin.');
  process.exit(1);
}

// ─── AUTH HELPERS ─────────────────────────────────────────────────────────────
function getMasterB64() {
  // Burada artık default yok — yukarıda process.exit ile garantiledik
  return 'Basic ' + Buffer.from(`admin:${process.env.MASTER_ADMIN_PASSWORD}`).toString('base64');
}

function masterAuth(req, res) {
  const auth = req.headers.authorization;
  if (!auth || auth !== getMasterB64()) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Master Admin"');
    res.status(401).send('Yetkisiz erişim');
    return false;
  }
  return true;
}

async function tenantAuth(req, res, tenant) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', `Basic realm="${tenant.store_name} Admin"`);
    res.status(401).send('Yetkisiz erişim');
    return false;
  }
  const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  const inputPassword = decoded.slice(decoded.indexOf(':') + 1);
  const ok = await db.verifyAdminPassword(tenant, inputPassword);
  if (!ok) {
    res.setHeader('WWW-Authenticate', `Basic realm="${tenant.store_name} Admin"`);
    res.status(401).send('Yetkisiz erişim');
    return false;
  }
  return true;
}

// ─── HATA / ALERT SİSTEMİ ─────────────────────────────────────────────────────
// Slack webhook varsa oraya gönder, yoksa sadece console'a yaz.
async function sendAlert(tenantId, context, error) {
  const msg = `[CHATBOT ERROR] Tenant: ${tenantId} | ${context} | ${error}`;
  console.error(msg);

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;   // webhook yoksa atla

  try {
    const axios = require('axios');
    await axios.post(webhookUrl, {
      text: `🚨 *Chatbot Hatası*\nTenant: \`${tenantId}\`\nKonum: ${context}\nHata: \`${error}\`\nZaman: ${new Date().toLocaleString('tr-TR')}`
    }, { timeout: 3000 });
  } catch (_) {
    // Alert gönderilemedi — sessizce devam et, ana akışı engelleme
  }
}


// RAM: { sessionId → { tenantId, storeType, messages } }
const conversations = {};

// ─── ÜRÜN CACHE ───────────────────────────────────────────────────────────────
// { tenantId → { products, expiresAt } }  —  5 dakika TTL
const PRODUCT_CACHE_TTL = 5 * 60 * 1000; // 5 dakika
const productCache = new Map();

// ─── TENANT CACHE ─────────────────────────────────────────────────────────────
// Her /api/chat isteğinde DB'ye gitmek yerine tenant verisini önbellekte tut.
// TTL: 2 dakika — tenant ayarları sık değişmez ama güncellemeler gecikmesin.
const TENANT_CACHE_TTL = 2 * 60 * 1000;
const tenantCache = new Map();

async function getTenantCached(tenantId) {
  const cached = tenantCache.get(tenantId);
  if (cached && Date.now() < cached.expiresAt) return cached.tenant;
  const tenant = await db.getTenant(tenantId);
  if (tenant) {
    tenantCache.set(tenantId, { tenant, expiresAt: Date.now() + TENANT_CACHE_TTL });
  }
  return tenant;
}

function invalidateTenantCache(tenantId) {
  tenantCache.delete(tenantId);
}

async function getProductsCached(tenant) {
  const cached = productCache.get(tenant.tenant_id);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.products;
  }
  const products = tenant.platform === 'woocommerce'
    ? await woocommerce.getProducts(tenant)
    : await shopify.getProducts(tenant);
  productCache.set(tenant.tenant_id, {
    products,
    expiresAt: Date.now() + PRODUCT_CACHE_TTL
  });
  console.log(`[Cache] ${tenant.tenant_id} ürünleri güncellendi (${products.length} adet)`);
  return products;
}

// Cache'i manuel temizlemek için admin endpoint'e yardımcı
function invalidateProductCache(tenantId) {
  productCache.delete(tenantId);
}
// Lead yakalama - bot cevabında LEAD_DATA: formatını yakala
async function extractAndSaveLead(reply, tenantId, sessionId) {
  const match = reply.match(/LEAD_DATA:({.*?})/);
  if (match) {
    try {
      const data = JSON.parse(match[1]);
      await db.saveLead(tenantId, sessionId, data);
      console.log('Lead kaydedildi:', data);
    } catch(e) {
      console.error('Lead parse hatası:', e.message);
    }
  }
  // LEAD_DATA satırını cevaptan temizle (müşteri görmesin)
  return reply.replace(/LEAD_DATA:{.*?}/g, '').trim();
}


// pendingOrderEmail artık DB'de tutuluyor (db.setPendingOrderEmail / db.getPendingOrderEmail)

const SESSION_TTL = 30 * 60 * 1000;
const MAX_HISTORY = 20; // Sistem prompt hariç tutulacak max mesaj sayısı
const sessionTimers = {};

// Sistem prompt'u koruyarak geçmişi MAX_HISTORY mesajla sınırla
function trimHistory(msgs) {
  const systemMsg = msgs[0]; // index 0 her zaman system prompt
  const history = msgs.slice(1); // sistem dışı mesajlar
  if (history.length <= MAX_HISTORY) return msgs;
  return [systemMsg, ...history.slice(-MAX_HISTORY)];
}

function resetSessionTimer(sessionId) {
  if (sessionTimers[sessionId]) clearTimeout(sessionTimers[sessionId]);
  sessionTimers[sessionId] = setTimeout(async () => {
    delete conversations[sessionId];
    await db.setPendingOrderEmail(sessionId, false).catch(() => {});
    delete sessionTimers[sessionId];
  }, SESSION_TTL);
}

function extractEmail(text) {
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : null;
}

function isOrderQuery(text) {
  const keywords = ['sipariş', 'kargo', 'takip', 'nerede', 'gelmedi', 'ne zaman gelecek'];
  return keywords.some(k => text.toLowerCase().includes(k));
}


async function getProducts(tenant) {
  return getProductsCached(tenant);
}

async function getOrders(tenant, email) {
  if (tenant.platform === 'woocommerce') return await woocommerce.getOrdersByEmail(tenant, email);
  return await shopify.getOrdersByEmail(tenant, email);
}

// ─── MASTER ADMIN (tüm tenant'ları görür) ─────────────────────────────────────
app.get('/admin', async (req, res) => {
  const auth = req.headers.authorization;
  const masterPass = process.env.MASTER_ADMIN_PASSWORD; // env zorunlu — startup kontrolü garantiler
  if (!auth || auth !== 'Basic ' + Buffer.from(`admin:${masterPass}`).toString('base64')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Master Admin"');
    return res.status(401).send('Yetkisiz erişim');
  }

  try {
    const tenants = await db.getAllTenants();
    const stats = await db.getStats();
    const sessions = await db.getAllSessions();

    const tenantsHTML = tenants.map(t => `
      <tr>
        <td style="padding:12px 16px;font-weight:600;color:#2d3436">${escapeHtml(t.tenant_id)}</td>
        <td style="padding:12px 16px"><span style="background:${t.platform === 'shopify' ? '#e8f4fd' : '#f0f9f0'};color:${t.platform === 'shopify' ? '#2980b9' : '#27ae60'};padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600">${escapeHtml(t.platform)}</span></td>
        <td style="padding:12px 16px;font-size:13px">${escapeHtml(t.store_name)}</td>
        <td style="padding:12px 16px;font-size:13px;color:#636e72">${escapeHtml(t.shopify_url || t.wc_url || '-')}</td>
        <td style="padding:12px 16px;font-size:12px;color:#aaa">${new Date(t.created_at).toLocaleString('tr-TR')}</td>
        <td style="padding:12px 16px"><a href="/admin/tenant/${encodeURIComponent(t.tenant_id)}" style="background:linear-gradient(135deg,#667eea,#764ba2);color:white;padding:5px 14px;border-radius:12px;text-decoration:none;font-size:12px;font-weight:600">Detay</a></td>
      </tr>
    `).join('');

    res.send(`<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Master Admin Panel</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#f0f2f5; }
  .header { background:linear-gradient(135deg,#667eea,#764ba2); padding:20px 32px; color:white; display:flex; justify-content:space-between; align-items:center; }
  .header h1 { font-size:22px; font-weight:700; }
  .container { max-width:1200px; margin:24px auto; padding:0 24px; }
  .cards { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; margin-bottom:24px; }
  .card { background:white; border-radius:14px; padding:20px 24px; box-shadow:0 2px 12px rgba(0,0,0,0.06); }
  .card-label { font-size:12px; color:#888; font-weight:600; text-transform:uppercase; }
  .card-value { font-size:38px; font-weight:700; margin-top:6px; background:linear-gradient(135deg,#667eea,#764ba2); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
  .section { background:white; border-radius:14px; box-shadow:0 2px 12px rgba(0,0,0,0.06); margin-bottom:20px; overflow:hidden; }
  .section-header { padding:18px 24px; border-bottom:1px solid #f0f0f0; display:flex; justify-content:space-between; align-items:center; }
  .section-header h2 { font-size:15px; font-weight:700; color:#2d3436; }
  table { width:100%; border-collapse:collapse; }
  thead { background:#f7f8fc; }
  th { padding:10px 16px; text-align:left; font-size:12px; color:#888; font-weight:600; text-transform:uppercase; }
  tr:hover { background:#f7f8fc; }
  .add-btn { background:linear-gradient(135deg,#667eea,#764ba2); color:white; border:none; padding:8px 18px; border-radius:20px; cursor:pointer; font-size:13px; font-weight:600; text-decoration:none; }
</style>
</head>
<body>
<div class="header">
  <div><h1>🤖 Master Admin Panel</h1><p>Tüm müşteriler — ${new Date().toLocaleString('tr-TR')}</p></div>
  <a href="/admin/new-tenant" class="add-btn">+ Yeni Müşteri Ekle</a>
</div>
<div class="container">
  <div class="cards">
    <div class="card"><div class="card-label">Toplam Tenant</div><div class="card-value">${tenants.length}</div></div>
    <div class="card"><div class="card-label">Toplam Konuşma</div><div class="card-value">${stats.totalSessions}</div></div>
    <div class="card"><div class="card-label">Toplam Mesaj</div><div class="card-value">${stats.totalMessages}</div></div>
  </div>
  <div class="section">
    <div class="section-header"><h2>🏪 Müşteriler</h2></div>
    <table>
      <thead><tr><th>Tenant ID</th><th>Platform</th><th>Mağaza</th><th>URL</th><th>Eklenme</th><th>İşlem</th></tr></thead>
      <tbody>${tenantsHTML}</tbody>
    </table>
  </div>
</div>
</body>
</html>`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── YENİ TENANT EKLE FORMU ───────────────────────────────────────────────────
app.get('/admin/new-tenant', (req, res) => {
  const auth = req.headers.authorization;
  const masterPass = process.env.MASTER_ADMIN_PASSWORD; // env zorunlu — startup kontrolü garantiler
  if (!auth || auth !== 'Basic ' + Buffer.from(`admin:${masterPass}`).toString('base64')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Master Admin"');
    return res.status(401).send('Yetkisiz');
  }

  res.send(`<!DOCTYPE html>
<html lang="tr">
<head><meta charset="UTF-8"><title>Yeni Müşteri Ekle</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#f0f2f5; }
  .header { background:linear-gradient(135deg,#667eea,#764ba2); padding:20px 32px; color:white; }
  .header h1 { font-size:20px; font-weight:700; }
  .container { max-width:600px; margin:32px auto; padding:0 24px; }
  .form-card { background:white; border-radius:14px; padding:32px; box-shadow:0 2px 12px rgba(0,0,0,0.06); }
  .form-group { margin-bottom:20px; }
  label { display:block; font-size:13px; font-weight:600; color:#636e72; margin-bottom:6px; }
  input, select { width:100%; padding:10px 14px; border:1px solid #dfe6e9; border-radius:8px; font-size:14px; outline:none; }
  input:focus, select:focus { border-color:#667eea; }
  .section-title { font-size:14px; font-weight:700; color:#2d3436; margin:24px 0 12px; padding-bottom:8px; border-bottom:2px solid #f0f0f0; }
  .btn { width:100%; padding:12px; background:linear-gradient(135deg,#667eea,#764ba2); color:white; border:none; border-radius:10px; font-size:15px; font-weight:700; cursor:pointer; margin-top:8px; }
</style>
</head>
<body>
<div class="header"><h1>➕ Yeni Müşteri Ekle</h1></div>
<div class="container">
<div class="form-card">
<form action="/admin/new-tenant" method="POST">
  <div class="section-title">Temel Bilgiler</div>
  <div class="form-group">
    <label>Tenant ID (benzersiz, boşluksuz)</label>
    <input name="tenant_id" placeholder="ahmet-elektronik" required>
  </div>
  <div class="form-group">
    <label>Platform</label>
    <select name="platform">
      <option value="shopify">Shopify</option>
      <option value="woocommerce">WooCommerce</option>
    </select>
  </div>
  <div class="form-group">
    <label>Mağaza Adı</label>
    <input name="store_name" placeholder="Ahmet Elektronik" required>
  </div>
  <div class="form-group">
    <label>WhatsApp Numarası (90 ile başla)</label>
    <input name="whatsapp" placeholder="905551234567">
  </div>
  <div class="form-group">
    <label>Admin Şifresi</label>
    <input name="admin_password" placeholder="güçlü bir şifre">
  </div>

  <div class="section-title">Kargo & İade</div>
  <div class="form-group">
    <label>Kargo Süresi</label>
    <input name="shipping_days" placeholder="3-5" value="3-5">
  </div>
  <div class="form-group">
    <label>Kargo Firması</label>
    <input name="shipping_company" placeholder="Yurtiçi Kargo" value="Yurtiçi Kargo">
  </div>
  <div class="form-group">
    <label>İade Süresi (gün)</label>
    <input name="return_days" placeholder="14" value="14">
  </div>

  <div class="section-title">Shopify (Shopify ise doldur)</div>
  <div class="form-group">
    <label>Shopify Store URL</label>
    <input name="shopify_url" placeholder="magazaadi.myshopify.com">
  </div>
  <div class="form-group">
    <label>Shopify Access Token</label>
    <input name="shopify_token" placeholder="shpat_...">
  </div>

  <div class="section-title">WooCommerce (WC ise doldur)</div>
  <div class="form-group">
    <label>WooCommerce URL</label>
    <input name="wc_url" placeholder="https://magazaadi.com">
  </div>
  <div class="form-group">
    <label>WC Consumer Key</label>
    <input name="wc_key" placeholder="ck_...">
  </div>
  <div class="form-group">
    <label>WC Consumer Secret</label>
    <input name="wc_secret" placeholder="cs_...">
  </div>

  <button type="submit" class="btn">✅ Müşteriyi Ekle</button>
</form>
</div>
</div>
</body>
</html>`);
});

app.post('/admin/new-tenant', express.urlencoded({ extended: true }), async (req, res) => {
  const auth = req.headers.authorization;
  const masterPass = process.env.MASTER_ADMIN_PASSWORD; // env zorunlu — startup kontrolü garantiler
  if (!auth || auth !== 'Basic ' + Buffer.from(`admin:${masterPass}`).toString('base64')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Master Admin"');
    return res.status(401).send('Yetkisiz');
  }

  try {
    await db.createTenant(req.body);
    res.redirect('/admin');
  } catch (err) {
    res.status(500).send(`Hata: ${err.message}`);
  }
});

// ─── TENANT'A ÖZEL ADMIN ──────────────────────────────────────────────────────
app.get('/admin/tenant/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  const tenant = await db.getTenant(tenantId);
  if (!tenant) return res.status(404).send('Tenant bulunamadı');

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', `Basic realm="${tenant.store_name} Admin"`);
    return res.status(401).send('Yetkisiz erişim');
  }

  // Basic auth decode → "admin:şifre"
  const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  const colonIdx = decoded.indexOf(':');
  const inputPassword = colonIdx !== -1 ? decoded.slice(colonIdx + 1) : '';

  const passwordOk = await db.verifyAdminPassword(tenant, inputPassword);
  if (!passwordOk) {
    res.setHeader('WWW-Authenticate', `Basic realm="${tenant.store_name} Admin"`);
    return res.status(401).send('Yetkisiz erişim');
  }

  try {
    const stats = await db.getStats(tenantId);
    const sessions = await db.getAllSessions(tenantId);
    const leads = await db.getLeads(tenantId);

    const sessionsHTML = sessions.map(s => `
      <tr onclick="loadConversation('${escapeHtml(s.session_id)}')" style="cursor:pointer">
        <td style="padding:12px 16px;font-size:13px;color:#636e72;font-family:monospace">${escapeHtml(s.session_id.substring(0,16))}...</td>
        <td style="padding:12px 16px;font-size:13px">${s.customer_email ? `<span style="background:#ffeaa7;padding:3px 8px;border-radius:8px;font-size:12px">📧 ${escapeHtml(s.customer_email)}</span>` : '-'}</td>
        <td style="padding:12px 16px;font-size:13px;max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(s.first_message || '-')}</td>
        <td style="padding:12px 16px;text-align:center"><span style="background:linear-gradient(135deg,#667eea,#764ba2);color:white;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600">${parseInt(s.message_count) || 0}</span></td>
        <td style="padding:12px 16px;font-size:12px;color:#aaa">${new Date(s.updated_at).toLocaleString('tr-TR')}</td>
      </tr>
    `).join('');

    res.send(`<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${escapeHtml(tenant.store_name)} Admin</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#f0f2f5; }
  .header { background:linear-gradient(135deg,#667eea,#764ba2); padding:20px 32px; color:white; display:flex; justify-content:space-between; align-items:center; }
  .header h1 { font-size:22px; font-weight:700; }
  .container { max-width:1100px; margin:24px auto; padding:0 24px; }
  .cards { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; margin-bottom:24px; }
  .card { background:white; border-radius:14px; padding:20px 24px; box-shadow:0 2px 12px rgba(0,0,0,0.06); }
  .card-label { font-size:12px; color:#888; font-weight:600; text-transform:uppercase; }
  .card-value { font-size:38px; font-weight:700; margin-top:6px; background:linear-gradient(135deg,#667eea,#764ba2); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
  .section { background:white; border-radius:14px; box-shadow:0 2px 12px rgba(0,0,0,0.06); margin-bottom:20px; overflow:hidden; }
  .section-header { padding:18px 24px; border-bottom:1px solid #f0f0f0; }
  .section-header h2 { font-size:15px; font-weight:700; color:#2d3436; }
  table { width:100%; border-collapse:collapse; }
  thead { background:#f7f8fc; }
  th { padding:10px 16px; text-align:left; font-size:12px; color:#888; font-weight:600; text-transform:uppercase; }
  tr:hover { background:#f7f8fc; }
  .modal { display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); z-index:1000; align-items:center; justify-content:center; }
  .modal.active { display:flex; }
  .modal-box { background:white; border-radius:20px; width:580px; max-height:80vh; display:flex; flex-direction:column; box-shadow:0 20px 60px rgba(0,0,0,0.2); }
  .modal-header { padding:20px 24px; border-bottom:1px solid #f0f0f0; display:flex; justify-content:space-between; align-items:center; }
  .modal-header h3 { font-size:15px; font-weight:700; }
  .modal-close { background:none; border:none; font-size:20px; cursor:pointer; color:#888; }
  .modal-body { flex:1; overflow-y:auto; padding:20px; display:flex; flex-direction:column; gap:12px; }
  .chat-msg { display:flex; gap:8px; align-items:flex-end; }
  .chat-msg.user { flex-direction:row-reverse; }
  .chat-bubble { max-width:75%; padding:10px 14px; border-radius:16px; font-size:13px; line-height:1.5; }
  .chat-bubble.user { background:linear-gradient(135deg,#667eea,#764ba2); color:white; border-bottom-right-radius:4px; }
  .chat-bubble.assistant { background:#f0f2f5; color:#2d3436; border-bottom-left-radius:4px; }
  .chat-time { font-size:11px; color:#aaa; }
</style>
</head>
<body>
<div class="header">
  <div><h1>🤖 ${escapeHtml(tenant.store_name)} Admin</h1><p style="opacity:.85;font-size:13px">${new Date().toLocaleString('tr-TR')}</p></div>
  <button onclick="location.reload()" style="background:rgba(255,255,255,0.2);color:white;border:none;padding:8px 18px;border-radius:20px;cursor:pointer;font-weight:600">🔄 Yenile</button>
</div>
<div class="container">
  <div class="cards">
    <div class="card"><div class="card-label">Toplam Konuşma</div><div class="card-value">${stats.totalSessions}</div></div>
    <div class="card"><div class="card-label">Toplam Mesaj</div><div class="card-value">${stats.totalMessages}</div></div>
    <div class="card"><div class="card-label">Bugün</div><div class="card-value">${stats.todaySessions}</div></div>
  </div>
  <div class="section">
      <div class="section" style="margin-bottom:20px">
    <div class="section-header" style="padding:18px 24px;border-bottom:1px solid #f0f0f0;display:flex;justify-content:space-between;align-items:center">
      <h2 style="font-size:15px;font-weight:700;color:#2d3436">🎯 Potansiyel Müşteriler (Leads)</h2>
      <span style="font-size:12px;color:#aaa">\${leads.length} lead</span>
    </div>
    \${leads.length === 0 ? '<div style="padding:24px;text-align:center;color:#aaa;font-size:13px">Henüz lead yok. Bot sohbet sırasında iletişim bilgisi aldığında burada görünecek.</div>' : \`
    <table style="width:100%;border-collapse:collapse">
      <thead style="background:#f7f8fc">
        <tr>
          <th style="padding:10px 16px;text-align:left;font-size:12px;color:#888;font-weight:600;text-transform:uppercase">Ad</th>
          <th style="padding:10px 16px;text-align:left;font-size:12px;color:#888;font-weight:600;text-transform:uppercase">Email</th>
          <th style="padding:10px 16px;text-align:left;font-size:12px;color:#888;font-weight:600;text-transform:uppercase">Telefon</th>
          <th style="padding:10px 16px;text-align:left;font-size:12px;color:#888;font-weight:600;text-transform:uppercase">İlgilendiği Ürün</th>
          <th style="padding:10px 16px;text-align:left;font-size:12px;color:#888;font-weight:600;text-transform:uppercase">Tarih</th>
        </tr>
      </thead>
      <tbody>
        \${leads.map(l => \`
          <tr style="border-bottom:1px solid #f0f0f0">
            <td style="padding:12px 16px;font-size:13px;font-weight:600">\${escapeHtml(l.name || '-')}</td>
            <td style="padding:12px 16px;font-size:13px">\${l.email ? \`<a href="mailto:\${escapeHtml(l.email)}" style="color:#667eea">\${escapeHtml(l.email)}</a>\` : '-'}</td>
            <td style="padding:12px 16px;font-size:13px">\${l.phone ? \`<a href="tel:\${escapeHtml(l.phone)}" style="color:#667eea">\${escapeHtml(l.phone)}</a>\` : '-'}</td>
            <td style="padding:12px 16px;font-size:13px;color:#636e72">\${escapeHtml(l.interested_product || '-')}</td>
            <td style="padding:12px 16px;font-size:12px;color:#aaa">\${new Date(l.created_at).toLocaleString('tr-TR')}</td>
          </tr>
        \`).join('')}
      </tbody>
    </table>
    \`}
  </div>
    <div class="section-header"><h2>💬 Son Konuşmalar <span style="font-size:12px;color:#aaa;font-weight:400">— detay için tıkla</span></h2></div>
    <table>
      <thead><tr><th>Session</th><th>Email</th><th>İlk Mesaj</th><th style="text-align:center">Mesaj</th><th>Son Aktivite</th></tr></thead>
      <tbody>${sessionsHTML}</tbody>
    </table>
  </div>
</div>
<div class="modal" id="modal">
  <div class="modal-box">
    <div class="modal-header">
      <h3 id="modal-title">Konuşma Detayı</h3>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body" id="modal-body"></div>
  </div>
</div>
<script>
// Credential'i sayfada sakla; server-side sifre embed etme.
// Kullanici bu sayfaya giris yaptiginda Basic Auth popup'i gosterilir.
// Biz o credential'i sessionStorage'da tutarak sonraki fetch'lerde kullaniyoruz.
(function initCredential() {
  if (!sessionStorage.getItem('adminAuth')) {
    const raw = prompt('Admin sifrenizi girin:');
    if (raw) sessionStorage.setItem('adminAuth', 'Basic ' + btoa('admin:' + raw));
  }
})();

async function loadConversation(sessionId) {
  document.getElementById('modal-title').textContent = 'Konusma: ' + sessionId.substring(0,16) + '...';
  document.getElementById('modal-body').innerHTML = '<div style="text-align:center;color:#aaa;padding:20px">Yukleniyor...</div>';
  document.getElementById('modal').classList.add('active');
  try {
    const authHeader = sessionStorage.getItem('adminAuth') || '';
    const res = await fetch('/admin/conversation/' + sessionId, {
      headers: { 'Authorization': authHeader }
    });
    if (res.status === 401) {
      sessionStorage.removeItem('adminAuth');
      document.getElementById('modal-body').innerHTML = '<div style="color:red">Oturum suresi doldu, sayfayi yenileyin.</div>';
      return;
    }
    const messages = await res.json();
    document.getElementById('modal-body').innerHTML = messages.map(m => \`
      <div class="chat-msg \${m.role === 'user' ? 'user' : ''}">
        <div class="chat-bubble \${m.role === 'user' ? 'user' : 'assistant'}">\${m.message}</div>
        <div class="chat-time">\${new Date(m.created_at).toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'})}</div>
      </div>
    \`).join('');
  } catch(e) {
    document.getElementById('modal-body').innerHTML = '<div style="color:red">Hata oluştu</div>';
  }
}
function closeModal() { document.getElementById('modal').classList.remove('active'); }
document.getElementById('modal').addEventListener('click', e => { if(e.target===this) closeModal(); });
</script>
</body>
</html>`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/conversation/:sessionId', async (req, res) => {
  // Güvenlik: ya master admin ya da session'ın sahibi tenant admin girebilir.
  const auth = req.headers.authorization;
  if (!auth) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Yetkisiz');
  }

  // 1) Master admin mi?
  if (auth === getMasterB64()) {
    try {
      const messages = await db.getSessionMessages(req.params.sessionId);
      return res.json(messages);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // 2) Tenant admin mi? — session'ın tenant'ını bul, o tenant'ın şifresiyle doğrula
  try {
    const session = await db.getSessionBySessionId(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session bulunamadı' });

    const tenant = await db.getTenant(session.tenant_id);
    if (!tenant) return res.status(404).json({ error: 'Tenant bulunamadı' });

    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const inputPassword = decoded.slice(decoded.indexOf(':') + 1);
    const ok = await db.verifyAdminPassword(tenant, inputPassword);
    if (!ok) {
      res.setHeader('WWW-Authenticate', `Basic realm="${tenant.store_name} Admin"`);
      return res.status(401).send('Yetkisiz');
    }

    const messages = await db.getSessionMessages(req.params.sessionId);
    return res.json(messages);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── ANA CHAT ─────────────────────────────────────────────────────────────────
app.post('/api/chat', chatLimiter, async (req, res) => {
  const { message, sessionId, tenant_id } = req.body;

  if (!message || !sessionId || !tenant_id) {
    return res.status(400).json({ error: 'message, sessionId ve tenant_id zorunludur.' });
  }

  const tenant = await getTenantCached(tenant_id);
  if (!tenant) {
    return res.status(404).json({ error: 'Geçersiz tenant.' });
  }

  try {
    resetSessionTimer(sessionId);

    if (!conversations[sessionId]) {
      const products = await getProducts(tenant);
      const systemContent = buildSystemPrompt(products, tenant);

      // ─── RESTART SONRASI GEÇMİŞİ KURTAR ─────────────────────────────────
      // RAM boşsa (restart sonrası) DB'deki konuşma geçmişini yeniden yükle.
      // Böylece müşteri "az önce beden sorduydum" dedi, bot yeniden başlamıyor.
      const dbHistory = await db.getSessionMessages(sessionId).catch(() => []);
      const restoredMessages = dbHistory.map(row => ({
        role: row.role,       // 'user' | 'assistant'
        content: row.message
      }));

      conversations[sessionId] = {
        tenantId: tenant_id,
        storeType: tenant.platform,
        messages: [
          { role: 'system', content: systemContent },
          ...restoredMessages
        ]
      };

      if (restoredMessages.length > 0) {
        console.log(`[Session] ${sessionId} — ${restoredMessages.length} mesaj DB'den geri yüklendi`);
      }
    }

    const msgs = conversations[sessionId].messages;

    if (await db.getPendingOrderEmail(sessionId)) {
      const email = extractEmail(message);
      if (email) {
        await db.setPendingOrderEmail(sessionId, false);
        await db.updateSessionEmail(sessionId, email);
        const orders = await getOrders(tenant, email);

        // Sipariş bulunamadıysa GPT'ye sormadan direkt cevap dön.
        // GPT'ye bırakırsak bağlamdan hallüsinasyon üretebilir.
        if (orders.length === 0) {
          const reply = `**${email}** adresine ait herhangi bir sipariş bulunamadı. 🔍\n\nEmail adresini doğru yazdığınızdan emin misiniz? Farklı bir adresle tekrar deneyebilirsiniz.`;
          msgs.push({ role: 'assistant', content: reply });
          await db.saveMessage(tenant_id, sessionId, 'user', message, tenant.platform);
          await db.saveMessage(tenant_id, sessionId, 'assistant', reply, tenant.platform);
          return res.json({ reply });
        }

        const orderText = orders.map(o => {
            const trackingLink = o.tracking && o.tracking !== 'Henüz yok'
              ? `\nKargo Takip: <a href="https://www.yurticikargo.com/tr/online-islemler/gonderi-sorgula?code=${o.tracking}" target="_blank" style="display:inline-block;margin-top:8px;background:#e74c3c;color:white;padding:8px 16px;border-radius:20px;text-decoration:none;font-size:13px;font-weight:600">📦 Kargonu Takip Et</a>`
              : '\nKargo: Henüz kargoya verilmedi';
            return `Sipariş #${o.id} | Tarih: ${o.date} | Durum: ${o.fulfillment || o.status || 'Hazırlanıyor'} | Takip No: ${o.tracking} | Toplam: ${o.total} | Ürünler: ${o.items.join(', ')}${trackingLink}`;
          }).join('\n\n');

        msgs.push({ role: 'user', content: `Email: ${email}` });
        // Kesin talimat: sadece aşağıdaki veriyi kullan, asla tahmin etme veya uydurma.
        msgs.push({ role: 'system', content: `GERÇEK SİPARİŞ VERİSİ (SADECE BUNU KULLAN, ASLA TAHMIN ETME):\n${orderText}` });
        msgs.push({ role: 'user', content: 'Yukarıdaki gerçek sipariş verilerini müşteriye insanca anlat. Veri dışında HİÇBİR şey ekleme.' });

        let reply = await openai.chat(trimHistory(msgs), tenant);
        reply = await extractAndSaveLead(reply, tenant_id, sessionId);
        msgs.push({ role: 'assistant', content: reply });

        await db.saveMessage(tenant_id, sessionId, 'user', message, tenant.platform);
        await db.saveMessage(tenant_id, sessionId, 'assistant', reply, tenant.platform);

        return res.json({ reply });
      }
    } else if (isOrderQuery(message)) {
      await db.setPendingOrderEmail(sessionId, true);
    }

    msgs.push({ role: 'user', content: message });
    let reply = await openai.chat(trimHistory(msgs), tenant);
    reply = await extractAndSaveLead(reply, tenant_id, sessionId);
    msgs.push({ role: 'assistant', content: reply });

    await db.saveMessage(tenant_id, sessionId, 'user', message, tenant.platform);
    await db.saveMessage(tenant_id, sessionId, 'assistant', reply, tenant.platform);

    res.json({ reply });

  } catch (err) {
    // API hatalarını sınıflandır ve kullanıcıya anlamlı mesaj ver
    const isApiErr = err.response?.status;
    let userMsg = 'Bir hata oluştu, lütfen tekrar deneyin.';
    let logContext = 'Chat genel hata';

    if (isApiErr === 401 || isApiErr === 403) {
      logContext = `${tenant?.platform || '?'} API kimlik doğrulama hatası (${isApiErr})`;
      userMsg = 'Mağaza bağlantısında yetkilendirme sorunu oluştu. Lütfen daha sonra tekrar deneyin.';
    } else if (isApiErr === 429) {
      logContext = `${tenant?.platform || '?'} API rate limit aşıldı`;
      userMsg = 'Şu an çok fazla istek var, lütfen birkaç saniye bekleyip tekrar deneyin.';
    } else if (isApiErr >= 500) {
      logContext = `${tenant?.platform || '?'} API sunucu hatası (${isApiErr})`;
      userMsg = 'Mağaza sisteminde geçici bir sorun var. Lütfen biraz sonra tekrar deneyin.';
    } else if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
      logContext = `${tenant?.platform || '?'} API bağlantı hatası (${err.code})`;
      userMsg = 'Mağaza sunucusuna şu an ulaşılamıyor. Lütfen daha sonra tekrar deneyin.';
    }

    await sendAlert(tenant_id || 'bilinmiyor', logContext, err.message);
    res.status(500).json({ error: userMsg });
  }
});

// ─── YARDIMCI ENDPOINTLER ─────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ message: 'Chatbot server çalışıyor! 🚀', version: '2.0-multitenant' }));

// ─── LEAD KAYDET ─────────────────────────────────────────────────────────────
app.post('/api/lead', strictLimiter, async (req, res) => {
  const { tenant_id, sessionId, name, email, phone, product, notes } = req.body;
  if (!tenant_id) return res.status(400).json({ error: 'tenant_id zorunlu' });

  // Guvenlik: tenant_id'nin gercekten var oldugunu dogrula.
  // Boylece rastgele tenant_id ile sahte lead doldurma engellenir.
  const tenant = await db.getTenant(tenant_id).catch(() => null);
  if (!tenant) return res.status(404).json({ error: 'Gecersiz tenant.' });

  try {
    await db.saveLead(tenant_id, sessionId, { name, email, phone, product, notes });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CACHE TEMİZLE (Master Admin) ─────────────────────────────────────────────
// Ürün güncellemesi sonrası cache'i zorla temizlemek için kullan.
// GET /admin/cache/clear           → tüm tenantların cache'ini sil
// GET /admin/cache/clear/:tenantId → sadece o tenant'ı sil
// NOT: Express 5 + path-to-regexp v8 optional parametre (:param?) desteklemiyor.
// Bu yüzden iki ayrı route tanımladık.
app.get('/admin/cache/clear', (req, res) => {
  if (!masterAuth(req, res)) return;
  productCache.clear();
  res.json({ ok: true, cleared: 'all' });
});

app.get('/admin/cache/clear/:tenantId', (req, res) => {
  if (!masterAuth(req, res)) return;
  invalidateProductCache(req.params.tenantId);
  res.json({ ok: true, cleared: req.params.tenantId });
});

app.get('/stats', async (req, res) => {
  const auth = req.headers.authorization;
  const masterPass = process.env.MASTER_ADMIN_PASSWORD; // env zorunlu — startup kontrolü garantiler
  if (!auth || auth !== 'Basic ' + Buffer.from(`admin:${masterPass}`).toString('base64')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Stats"');
    return res.status(401).send('Yetkisiz');
  }
  try { res.json(await db.getStats()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GEÇİCİ: Tenant şifre sıfırlama (master auth gerekir) ───────────────────
// GET /admin/reset-password/:tenantId/:newPassword
// Kullandıktan sonra bu route'u silebilirsin.
app.get('/admin/reset-password/:tenantId/:newPassword', async (req, res) => {
  if (!masterAuth(req, res)) return;
  const { tenantId, newPassword } = req.params;
  const bcrypt = require('bcryptjs');
  const hashed = await bcrypt.hash(newPassword, 10);
  const p = require('./database').getPool ? require('./database') : null;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pool.query('UPDATE tenants SET admin_password = $1 WHERE tenant_id = $2', [hashed, tenantId]);
  await pool.end();
  res.json({ ok: true, tenant: tenantId, message: `Şifre "${newPassword}" olarak güncellendi` });
});

app.listen(process.env.PORT || 3000, async () => {
  console.log(`Server ${process.env.PORT || 3000} portunda çalışıyor`);
  await db.init().catch(console.error); // leads tablosu da init() içinde oluşuyor
});