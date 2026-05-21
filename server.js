const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const shopify = require('./shopify');
const woocommerce = require('./woocommerce');
const openai = require('./openai');
const db = require('./database');

// RAM: { sessionId → { tenantId, storeType, messages } }
const conversations = {};
const pendingOrderEmail = {};

const SESSION_TTL = 30 * 60 * 1000;
const sessionTimers = {};

function resetSessionTimer(sessionId) {
  if (sessionTimers[sessionId]) clearTimeout(sessionTimers[sessionId]);
  sessionTimers[sessionId] = setTimeout(() => {
    delete conversations[sessionId];
    delete pendingOrderEmail[sessionId];
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

function buildSystemPrompt(products, tenant) {
  const productList = JSON.stringify(products);
  return `Sen ${tenant.store_name} mağazasının deneyimli müşteri temsilcisi asistanısın. Samimi ve profesyonelsin.

KİŞİLİK:
- Müşteriyle sohbet eder gibi konuş, robot gibi değil
- Kısa cevaplar ver, gerekmedikçe uzatma
- Müşterinin ne istediğini anlamadan ürün listeleme
- Önce anla, sonra öner
- Hangi dilde yazılırsa o dilde cevap ver

ÜRÜN ÖNERİSİ KURALLARI:
- Müşteri "ürün göster" veya "ne var" derse direkt liste verme
- Önce şunu sor: ne amaçla kullanacak, bütçesi ne, tercihi ne
- Sonra EN FAZLA 2-3 ürün öner, neden önerdiğini açıkla
- Fiyatı TL olarak ver

MAĞAZA BİLGİLERİ:
- Mağaza: ${tenant.store_name}
- Platform: ${tenant.platform === 'woocommerce' ? 'WooCommerce' : 'Shopify'}
- Kargo: ${tenant.shipping_days} iş günü, ${tenant.shipping_company} ile
- İade: ${tenant.return_days} gün
- Destek: WhatsApp veya Telegram

ÜRÜN KATALOĞU (sadece sen gör, müşteriye liste olarak verme):
${productList}

KONUŞMA AKIŞI:
- Sipariş sorusu → email iste → siparişi getir
- Kargo takip sorusu → email iste → sipariş bul → takip linki ver
- Ürün sorusu → ihtiyacı anla → 2-3 ürün öner
- Şikayet → özür dile → WhatsApp/Telegram butonu sun
- Çözemediğin soru → WhatsApp/Telegram butonu sun

WHATSAPP/TELEGRAM YÖNLENDİRME:
Müşteri insan desteği istediğinde şu mesajı ver:
"Talebiniz alındı! Müşteri temsilcimiz en kısa sürede sizinle iletişime geçecektir. İsterseniz aşağıdaki kanallardan da ulaşabilirsiniz:"
Sonra şu HTML butonları ekle:
<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><a href="https://wa.me/${tenant.whatsapp}?text=Merhaba,%20chatbot%20üzerinden%20destek%20talep%20ediyorum" target="_blank" style="background:#25D366;color:white;padding:9px 18px;border-radius:20px;text-decoration:none;font-size:13px;font-weight:600;display:inline-flex;align-items:center;gap:6px">💬 WhatsApp ile Yaz</a><a href="https://t.me/${tenant.whatsapp}" target="_blank" style="background:#229ED9;color:white;padding:9px 18px;border-radius:20px;text-decoration:none;font-size:13px;font-weight:600;display:inline-flex;align-items:center;gap:6px">✈️ Telegram ile Yaz</a></div>

YAPMAMAN GEREKENLER:
- Tüm ürün listesini asla dökme
- Kesin fiyat garantisi verme
- Rakip marka önerme
- Üzgünüm yapamam deme, her zaman çözüm sun`;
}

async function getProducts(tenant) {
  if (tenant.platform === 'woocommerce') return await woocommerce.getProducts(tenant);
  return await shopify.getProducts(tenant);
}

async function getOrders(tenant, email) {
  if (tenant.platform === 'woocommerce') return await woocommerce.getOrdersByEmail(tenant, email);
  return await shopify.getOrdersByEmail(tenant, email);
}

// ─── MASTER ADMIN (tüm tenant'ları görür) ─────────────────────────────────────
app.get('/admin', async (req, res) => {
  const auth = req.headers.authorization;
  const masterPass = process.env.MASTER_ADMIN_PASSWORD || 'master1234';
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
        <td style="padding:12px 16px;font-weight:600;color:#2d3436">${t.tenant_id}</td>
        <td style="padding:12px 16px"><span style="background:${t.platform === 'shopify' ? '#e8f4fd' : '#f0f9f0'};color:${t.platform === 'shopify' ? '#2980b9' : '#27ae60'};padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600">${t.platform}</span></td>
        <td style="padding:12px 16px;font-size:13px">${t.store_name}</td>
        <td style="padding:12px 16px;font-size:13px;color:#636e72">${t.shopify_url || t.wc_url || '-'}</td>
        <td style="padding:12px 16px;font-size:12px;color:#aaa">${new Date(t.created_at).toLocaleString('tr-TR')}</td>
        <td style="padding:12px 16px"><a href="/admin/tenant/${t.tenant_id}" style="background:linear-gradient(135deg,#667eea,#764ba2);color:white;padding:5px 14px;border-radius:12px;text-decoration:none;font-size:12px;font-weight:600">Detay</a></td>
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
  const masterPass = process.env.MASTER_ADMIN_PASSWORD || 'master1234';
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
  const masterPass = process.env.MASTER_ADMIN_PASSWORD || 'master1234';
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
  const expectedPass = Buffer.from(`admin:${tenant.admin_password}`).toString('base64');
  if (!auth || auth !== `Basic ${expectedPass}`) {
    res.setHeader('WWW-Authenticate', `Basic realm="${tenant.store_name} Admin"`);
    return res.status(401).send('Yetkisiz erişim');
  }

  try {
    const stats = await db.getStats(tenantId);
    const sessions = await db.getAllSessions(tenantId);

    const sessionsHTML = sessions.map(s => `
      <tr onclick="loadConversation('${s.session_id}')" style="cursor:pointer">
        <td style="padding:12px 16px;font-size:13px;color:#636e72;font-family:monospace">${s.session_id.substring(0,16)}...</td>
        <td style="padding:12px 16px;font-size:13px">${s.customer_email ? `<span style="background:#ffeaa7;padding:3px 8px;border-radius:8px;font-size:12px">📧 ${s.customer_email}</span>` : '-'}</td>
        <td style="padding:12px 16px;font-size:13px;max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.first_message || '-'}</td>
        <td style="padding:12px 16px;text-align:center"><span style="background:linear-gradient(135deg,#667eea,#764ba2);color:white;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600">${s.message_count}</span></td>
        <td style="padding:12px 16px;font-size:12px;color:#aaa">${new Date(s.updated_at).toLocaleString('tr-TR')}</td>
      </tr>
    `).join('');

    res.send(`<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${tenant.store_name} Admin</title>
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
  <div><h1>🤖 ${tenant.store_name} Admin</h1><p style="opacity:.85;font-size:13px">${new Date().toLocaleString('tr-TR')}</p></div>
  <button onclick="location.reload()" style="background:rgba(255,255,255,0.2);color:white;border:none;padding:8px 18px;border-radius:20px;cursor:pointer;font-weight:600">🔄 Yenile</button>
</div>
<div class="container">
  <div class="cards">
    <div class="card"><div class="card-label">Toplam Konuşma</div><div class="card-value">${stats.totalSessions}</div></div>
    <div class="card"><div class="card-label">Toplam Mesaj</div><div class="card-value">${stats.totalMessages}</div></div>
    <div class="card"><div class="card-label">Bugün</div><div class="card-value">${stats.todaySessions}</div></div>
  </div>
  <div class="section">
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
async function loadConversation(sessionId) {
  document.getElementById('modal-title').textContent = 'Konuşma: ' + sessionId.substring(0,16) + '...';
  document.getElementById('modal-body').innerHTML = '<div style="text-align:center;color:#aaa;padding:20px">Yükleniyor...</div>';
  document.getElementById('modal').classList.add('active');
  try {
    const res = await fetch('/admin/conversation/' + sessionId, {
      headers: { 'Authorization': 'Basic ' + btoa('admin:${tenant.admin_password}') }
    });
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
  // Basic auth yeterli, hangi tenant olduğu önemli değil bu endpoint için
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).send('Yetkisiz');
  try {
    const messages = await db.getSessionMessages(req.params.sessionId);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ANA CHAT ─────────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message, sessionId, tenant_id } = req.body;

  if (!message || !sessionId || !tenant_id) {
    return res.status(400).json({ error: 'message, sessionId ve tenant_id zorunludur.' });
  }

  const tenant = await db.getTenant(tenant_id);
  if (!tenant) {
    return res.status(404).json({ error: 'Geçersiz tenant.' });
  }

  try {
    resetSessionTimer(sessionId);

    if (!conversations[sessionId]) {
      const products = await getProducts(tenant);
      conversations[sessionId] = {
        tenantId: tenant_id,
        storeType: tenant.platform,
        messages: [{ role: 'system', content: buildSystemPrompt(products, tenant) }]
      };
    }

    const msgs = conversations[sessionId].messages;

    if (pendingOrderEmail[sessionId]) {
      const email = extractEmail(message);
      if (email) {
        pendingOrderEmail[sessionId] = false;
        await db.updateSessionEmail(sessionId, email);
        const orders = await getOrders(tenant, email);

        let orderText;
        if (orders.length === 0) {
          orderText = `${email} adresine ait sipariş bulunamadı.`;
        } else {
          orderText = orders.map(o => {
            const trackingLink = o.tracking && o.tracking !== 'Henüz yok'
              ? `\nKargo Takip: <a href="https://www.yurticikargo.com/tr/online-islemler/gonderi-sorgula?code=${o.tracking}" target="_blank" style="display:inline-block;margin-top:8px;background:#e74c3c;color:white;padding:8px 16px;border-radius:20px;text-decoration:none;font-size:13px;font-weight:600">📦 Kargonu Takip Et</a>`
              : '\nKargo: Henüz kargoya verilmedi';
            return `Sipariş #${o.id} | Tarih: ${o.date} | Durum: ${o.fulfillment || o.status || 'Hazırlanıyor'} | Takip No: ${o.tracking} | Toplam: ${o.total} | Ürünler: ${o.items.join(', ')}${trackingLink}`;
          }).join('\n\n');
        }

        msgs.push({ role: 'user', content: `Email: ${email}` });
        msgs.push({ role: 'system', content: `Sipariş bilgileri:\n${orderText}` });
        msgs.push({ role: 'user', content: 'Bu sipariş bilgilerini müşteriye güzel bir şekilde açıkla.' });

        const reply = await openai.chat(msgs, tenant);
        msgs.push({ role: 'assistant', content: reply });

        await db.saveMessage(tenant_id, sessionId, 'user', message, tenant.platform);
        await db.saveMessage(tenant_id, sessionId, 'assistant', reply, tenant.platform);

        return res.json({ reply });
      }
    } else if (isOrderQuery(message)) {
      pendingOrderEmail[sessionId] = true;
    }

    msgs.push({ role: 'user', content: message });
    const reply = await openai.chat(msgs, tenant);
    msgs.push({ role: 'assistant', content: reply });

    await db.saveMessage(tenant_id, sessionId, 'user', message, tenant.platform);
    await db.saveMessage(tenant_id, sessionId, 'assistant', reply, tenant.platform);

    res.json({ reply });

  } catch (err) {
    console.error('Chat Hatası:', err.message);
    res.status(500).json({ error: 'Bir hata oluştu, lütfen tekrar deneyin.' });
  }
});

// ─── YARDIMCI ENDPOINTLER ─────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ message: 'Chatbot server çalışıyor! 🚀', version: '2.0-multitenant' }));

app.get('/stats', async (req, res) => {
  try { res.json(await db.getStats()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(process.env.PORT || 3000, async () => {
  console.log(`Server ${process.env.PORT || 3000} portunda çalışıyor`);
  await db.init().catch(console.error);
});