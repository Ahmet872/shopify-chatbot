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

function buildSystemPrompt(products, storeType) {
  const productList = JSON.stringify(products);
  return `Sen ${process.env.STORE_NAME} mağazasının deneyimli müşteri temsilcisi asistanısın. Samimi ve profesyonelsin.

KİŞİLİK:
- Müşteriyle sohbet eder gibi konuş, robot gibi değil
- Kısa cevaplar ver, gerekmedikçe uzatma
- Müşterinin ne istediğini anlamadan ürün listeleme
- Önce anla, sonra öner
- Müşteri hangi dilde yazarsa o dilde cevap ver (Türkçe, İngilizce, Almanca vb.)
- Dil algılamayı ilk mesajdan yap ve o dilde devam et

ÜRÜN ÖNERİSİ KURALLARI:
- Müşteri "ürün göster" veya "ne var" derse direkt liste verme
- Önce şunu sor: ne amaçla kullanacak, bütçesi ne, tercihi ne
- Sonra EN FAZLA 2-3 ürün öner, neden önerdiğini açıkla
- Fiyatı TL olarak ver

MAĞAZA BİLGİLERİ:
- Mağaza: ${process.env.STORE_NAME}
- Platform: ${storeType === 'woocommerce' ? 'WooCommerce' : 'Shopify'}
- Kargo: ${process.env.SHIPPING_DAYS} iş günü, ${process.env.SHIPPING_COMPANY} ile
- İade: ${process.env.RETURN_DAYS} gün
- Destek: WhatsApp veya Telegram

ÜRÜN KATALOĞU (sadece sen gör, müşteriye liste olarak verme):
${productList}

KONUŞMA AKIŞI:
- Sipariş sorusu → email iste → siparişi getir
- Ürün sorusu → ihtiyacı anla → 2-3 ürün öner
- Şikayet → özür dile → WhatsApp/Telegram butonu sun
- Çözemediğin soru → WhatsApp/Telegram butonu sun

WHATSAPP/TELEGRAM YÖNLENDİRME:
Müşteri insan desteği, yetkili, sorumlu veya mağaza sahibiyle görüşmek istediğinde şu mesajı ver:
"Talebiniz alındı! Müşteri temsilcimiz en kısa sürede sizinle iletişime geçecektir. İsterseniz aşağıdaki kanallardan da ulaşabilirsiniz:"
Sonra şu HTML butonları ekle:
<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><a href="https://wa.me/${process.env.WHATSAPP_NUMBER}?text=Merhaba,%20chatbot%20üzerinden%20destek%20talep%20ediyorum" target="_blank" style="background:#25D366;color:white;padding:9px 18px;border-radius:20px;text-decoration:none;font-size:13px;font-weight:600;display:inline-flex;align-items:center;gap:6px">💬 WhatsApp ile Yaz</a><a href="https://t.me/${process.env.WHATSAPP_NUMBER}" target="_blank" style="background:#229ED9;color:white;padding:9px 18px;border-radius:20px;text-decoration:none;font-size:13px;font-weight:600;display:inline-flex;align-items:center;gap:6px">✈️ Telegram ile Yaz</a></div>

YAPMAMAN GEREKENLER:
- Tüm ürün listesini asla dökme
- Kesin fiyat garantisi verme
- Rakip marka önerme
- Üzgünüm yapamam deme, her zaman çözüm sun`;
}

async function getProducts(storeType) {
  if (storeType === 'woocommerce') return await woocommerce.getProducts();
  return await shopify.getProducts();
}

async function getOrders(storeType, email) {
  if (storeType === 'woocommerce') return await woocommerce.getOrdersByEmail(email);
  return await shopify.getOrdersByEmail(email);
}

app.get('/', (req, res) => {
  res.json({ message: 'Chatbot server çalışıyor!' });
});

app.get('/test-shopify', async (req, res) => {
  try {
    const products = await shopify.getProducts();
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/test-woo', async (req, res) => {
  try {
    const products = await woocommerce.getProducts();
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/admin', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== 'Basic ' + Buffer.from('admin:1234').toString('base64')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Yetkisiz erişim');
  }
  try {
    const stats = await db.getStats();
    const sessions = await db.getAllSessions();

    const sessionsHTML = sessions.map(s => `
      <tr onclick="loadConversation('${s.session_id}')" style="cursor:pointer">
        <td style="padding:12px 16px;font-size:13px;color:#636e72;font-family:monospace">${s.session_id.substring(0,16)}...</td>
        <td style="padding:12px 16px"><span style="background:${s.store === 'shopify' ? '#e8f4fd' : '#f0f9f0'};color:${s.store === 'shopify' ? '#2980b9' : '#27ae60'};padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600">${s.store}</span></td>
        <td style="padding:12px 16px;font-size:13px;color:#2d3436">${s.customer_email ? `<span style="background:#ffeaa7;padding:3px 8px;border-radius:8px;font-size:12px">📧 ${s.customer_email}</span>` : '<span style="color:#aaa;font-size:12px">-</span>'}</td>
        <td style="padding:12px 16px;font-size:13px;color:#2d3436;max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.first_message || '-'}</td>
        <td style="padding:12px 16px;font-size:13px;text-align:center"><span style="background:linear-gradient(135deg,#667eea,#764ba2);color:white;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600">${s.message_count}</span></td>
        <td style="padding:12px 16px;font-size:12px;color:#aaa">${new Date(s.updated_at).toLocaleString('tr-TR')}</td>
      </tr>
    `).join('');

    res.send(`<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Chatbot Admin Panel</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; min-height: 100vh; }
  .header { background: linear-gradient(135deg, #667eea, #764ba2); padding: 20px 32px; color: white; display:flex; justify-content:space-between; align-items:center; }
  .header h1 { font-size: 22px; font-weight: 700; }
  .header p { opacity: 0.85; font-size: 13px; margin-top:2px; }
  .container { max-width: 1200px; margin: 24px auto; padding: 0 24px; }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px; }
  .card { background: white; border-radius: 14px; padding: 20px 24px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
  .card-label { font-size: 12px; color: #888; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  .card-value { font-size: 38px; font-weight: 700; margin-top: 6px; background: linear-gradient(135deg, #667eea, #764ba2); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .card-sub { font-size: 12px; color: #aaa; margin-top: 2px; }
  .section { background: white; border-radius: 14px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); margin-bottom: 20px; overflow:hidden; }
  .section-header { padding: 18px 24px; border-bottom: 1px solid #f0f0f0; display:flex; justify-content:space-between; align-items:center; }
  .section-header h2 { font-size: 15px; font-weight: 700; color: #2d3436; }
  table { width: 100%; border-collapse: collapse; }
  thead { background: #f7f8fc; }
  th { padding: 10px 16px; text-align: left; font-size: 12px; color: #888; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  tr:hover { background: #f7f8fc; }
  .modal { display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); z-index:1000; align-items:center; justify-content:center; }
  .modal.active { display:flex; }
  .modal-box { background:white; border-radius:20px; width:580px; max-height:80vh; display:flex; flex-direction:column; box-shadow: 0 20px 60px rgba(0,0,0,0.2); }
  .modal-header { padding:20px 24px; border-bottom:1px solid #f0f0f0; display:flex; justify-content:space-between; align-items:center; }
  .modal-header h3 { font-size:15px; font-weight:700; }
  .modal-close { background:none; border:none; font-size:20px; cursor:pointer; color:#888; }
  .modal-body { flex:1; overflow-y:auto; padding:20px 24px; display:flex; flex-direction:column; gap:12px; }
  .chat-msg { display:flex; gap:8px; align-items:flex-end; }
  .chat-msg.user { flex-direction:row-reverse; }
  .chat-bubble { max-width:75%; padding:10px 14px; border-radius:16px; font-size:13px; line-height:1.5; }
  .chat-bubble.user { background:linear-gradient(135deg,#667eea,#764ba2); color:white; border-bottom-right-radius:4px; }
  .chat-bubble.assistant { background:#f0f2f5; color:#2d3436; border-bottom-left-radius:4px; }
  .chat-time { font-size:11px; color:#aaa; padding:0 4px; }
  .question-row { display:flex; align-items:center; padding:12px 24px; border-bottom:1px solid #f0f0f0; }
  .question-row:last-child { border-bottom:none; }
  .q-num { color:#aaa; font-size:13px; width:24px; }
  .q-text { flex:1; font-size:13px; color:#2d3436; }
  .q-bar-wrap { width:200px; margin:0 16px; background:#f0f0f0; border-radius:4px; height:5px; }
  .q-bar { height:5px; border-radius:4px; background:linear-gradient(135deg,#667eea,#764ba2); }
  .q-count { background:linear-gradient(135deg,#667eea,#764ba2); color:white; padding:3px 10px; border-radius:12px; font-size:12px; font-weight:700; }
  .refresh-btn { background:linear-gradient(135deg,#667eea,#764ba2); color:white; border:none; padding:8px 18px; border-radius:20px; cursor:pointer; font-size:13px; font-weight:600; }
</style>
</head>
<body>
<div class="header">
  <div>
    <h1>🤖 Chatbot Admin Panel</h1>
    <p>Son güncelleme: ${new Date().toLocaleString('tr-TR')}</p>
  </div>
  <button class="refresh-btn" onclick="location.reload()">🔄 Yenile</button>
</div>
<div class="container">
  <div class="cards">
    <div class="card">
      <div class="card-label">Toplam Konuşma</div>
      <div class="card-value">${stats.totalSessions}</div>
      <div class="card-sub">Benzersiz kullanıcı</div>
    </div>
    <div class="card">
      <div class="card-label">Toplam Mesaj</div>
      <div class="card-value">${stats.totalMessages}</div>
      <div class="card-sub">Gönderilen mesaj</div>
    </div>
    <div class="card">
      <div class="card-label">Bugün</div>
      <div class="card-value">${stats.todaySessions}</div>
      <div class="card-sub">Aktif konuşma</div>
    </div>
  </div>
  <div class="section">
    <div class="section-header">
      <h2>💬 Son Konuşmalar</h2>
      <span style="font-size:12px;color:#aaa">Detay için tıkla</span>
    </div>
    <table>
      <thead>
        <tr>
          <th>Session ID</th>
          <th>Platform</th>
          <th>Email</th>
          <th>İlk Mesaj</th>
          <th style="text-align:center">Mesaj</th>
          <th>Son Aktivite</th>
        </tr>
      </thead>
      <tbody>${sessionsHTML}</tbody>
    </table>
  </div>
  <div class="section">
    <div class="section-header"><h2>🔥 En Çok Sorulan Sorular</h2></div>
    ${stats.topQuestions.map((q, i) => {
      const pct = Math.round((q.count / stats.topQuestions[0].count) * 100);
      return `<div class="question-row">
        <span class="q-num">${i+1}</span>
        <span class="q-text">${q.message}</span>
        <div class="q-bar-wrap"><div class="q-bar" style="width:${pct}%"></div></div>
        <span class="q-count">${q.count}x</span>
      </div>`;
    }).join('')}
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
      headers: { 'Authorization': 'Basic ' + btoa('admin:1234') }
    });
    const messages = await res.json();
    const html = messages.map(m => \`
      <div class="chat-msg \${m.role === 'user' ? 'user' : ''}">
        <div class="chat-bubble \${m.role === 'user' ? 'user' : 'assistant'}">\${m.message}</div>
        <div class="chat-time">\${new Date(m.created_at).toLocaleTimeString('tr-TR', {hour:'2-digit',minute:'2-digit'})}</div>
      </div>
    \`).join('');
    document.getElementById('modal-body').innerHTML = html;
  } catch(e) {
    document.getElementById('modal-body').innerHTML = '<div style="color:red">Hata oluştu</div>';
  }
}
function closeModal() {
  document.getElementById('modal').classList.remove('active');
}
document.getElementById('modal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});
</script>
</body>
</html>`);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/admin/conversation/:sessionId', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== 'Basic ' + Buffer.from('admin:1234').toString('base64')) {
    return res.status(401).send('Yetkisiz');
  }
  try {
    const messages = await db.getSessionMessages(req.params.sessionId);
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/stats', async (req, res) => {
  try {
    const stats = await db.getStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/chat', async (req, res) => {
  const { message, sessionId, store = 'shopify' } = req.body;

  if (!message || !sessionId) {
    return res.status(400).json({ error: 'message ve sessionId zorunludur.' });
  }

  try {
    resetSessionTimer(sessionId);

    if (!conversations[sessionId]) {
      const products = await getProducts(store);
      conversations[sessionId] = {
        storeType: store,
        messages: [{ role: 'system', content: buildSystemPrompt(products, store) }]
      };
    }

    const storeType = conversations[sessionId].storeType;
    const msgs = conversations[sessionId].messages;

    if (pendingOrderEmail[sessionId]) {
      const email = extractEmail(message);
      if (email) {
        pendingOrderEmail[sessionId] = false;
        await db.updateSessionEmail(sessionId, email);
        const orders = await getOrders(storeType, email);

        let orderText;
        if (orders.length === 0) {
          orderText = `${email} adresine ait sipariş bulunamadı.`;
        } else {
          orderText = orders.map(o => {
            const trackingLink = o.tracking && o.tracking !== 'Henüz yok'
              ? `\nKargo Takip Linki: <a href="https://www.yurticikargo.com/tr/online-islemler/gonderi-sorgula?code=${o.tracking}" target="_blank" style="display:inline-block;margin-top:8px;background:#e74c3c;color:white;padding:8px 16px;border-radius:20px;text-decoration:none;font-size:13px;font-weight:600">📦 Kargonu Takip Et</a>`
              : '\nKargo: Henüz kargoya verilmedi';
            return `Sipariş #${o.id} | Tarih: ${o.date} | Durum: ${o.fulfillment || o.status || 'Hazırlanıyor'} | Takip No: ${o.tracking} | Toplam: ${o.total} | Ürünler: ${o.items.join(', ')}${trackingLink}`;
          }).join('\n\n');
        }

        msgs.push({ role: 'user', content: `Email: ${email}` });
        msgs.push({ role: 'system', content: `Sipariş bilgileri:\n${orderText}` });
        msgs.push({ role: 'user', content: 'Bu sipariş bilgilerini müşteriye güzel bir şekilde açıkla.' });

        const reply = await openai.chat(msgs);
        msgs.push({ role: 'assistant', content: reply });

        await db.saveMessage(sessionId, 'user', message, store);
        await db.saveMessage(sessionId, 'assistant', reply, store);

        return res.json({ reply });
      }
    } else if (isOrderQuery(message)) {
      pendingOrderEmail[sessionId] = true;
    }

    msgs.push({ role: 'user', content: message });
    const reply = await openai.chat(msgs);
    msgs.push({ role: 'assistant', content: reply });

    await db.saveMessage(sessionId, 'user', message, store);
    await db.saveMessage(sessionId, 'assistant', reply, store);

    res.json({ reply });

  } catch (error) {
    console.error('Chat Hatası:', error.message);
    res.status(500).json({ error: 'Bir hata oluştu, lütfen tekrar deneyin.' });
  }
});

app.listen(process.env.PORT, async () => {
  console.log(`Server ${process.env.PORT} portunda çalışıyor`);
  await db.init().catch(console.error);
});