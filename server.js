const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const shopify = require('./shopify');
const openai = require('./openai');
const db = require('./database');

const conversations = {};
const pendingOrderEmail = {};

// Bellek sızıntısını önlemek için oturum temizleme (30 dk)
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

function buildSystemPrompt(products) {
  const productList = JSON.stringify(products);
  return `Sen ${process.env.STORE_NAME} mağazasının deneyimli müşteri temsilcisi asistanısın...
  
ÜRÜN KATALOĞU:
${productList}`;
  // ... (aynı kalır)
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

app.get('/admin', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== 'Basic ' + Buffer.from('admin:1234').toString('base64')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Yetkisiz erişim');
  }
  try {
    const stats = await db.getStats();
    res.send(`<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Chatbot Admin Panel</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; min-height: 100vh; }
  .header { background: linear-gradient(135deg, #667eea, #764ba2); padding: 24px 32px; color: white; }
  .header h1 { font-size: 24px; font-weight: 700; }
  .header p { opacity: 0.85; margin-top: 4px; font-size: 14px; }
  .container { max-width: 1100px; margin: 32px auto; padding: 0 24px; }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-bottom: 32px; }
  .card { background: white; border-radius: 16px; padding: 24px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
  .card-label { font-size: 13px; color: #888; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }
  .card-value { font-size: 42px; font-weight: 700; margin-top: 8px; background: linear-gradient(135deg, #667eea, #764ba2); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .card-sub { font-size: 13px; color: #aaa; margin-top: 4px; }
  .section { background: white; border-radius: 16px; padding: 24px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); margin-bottom: 20px; }
  .section h2 { font-size: 16px; font-weight: 700; color: #2d3436; margin-bottom: 20px; display: flex; align-items: center; gap: 8px; }
  .question-row { display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #f0f0f0; }
  .question-row:last-child { border-bottom: none; }
  .question-text { font-size: 14px; color: #2d3436; flex: 1; }
  .question-count { background: linear-gradient(135deg, #667eea, #764ba2); color: white; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 700; margin-left: 16px; }
  .bar-container { flex: 1; margin: 0 16px; background: #f0f0f0; border-radius: 4px; height: 6px; }
  .bar { height: 6px; border-radius: 4px; background: linear-gradient(135deg, #667eea, #764ba2); }
  .refresh-btn { background: linear-gradient(135deg, #667eea, #764ba2); color: white; border: none; padding: 10px 20px; border-radius: 20px; cursor: pointer; font-size: 14px; font-weight: 600; }
  .footer { text-align: center; color: #aaa; font-size: 12px; padding: 24px; }
</style>
</head>
<body>
<div class="header">
  <h1>🤖 Chatbot Admin Panel</h1>
  <p>Son güncelleme: ${new Date().toLocaleString('tr-TR')}</p>
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
    <h2>🔥 En Çok Sorulan Sorular</h2>
    ${stats.topQuestions.length === 0 ? '<p style="color:#aaa;font-size:14px">Henüz veri yok</p>' : 
      stats.topQuestions.map((q, i) => {
        const maxCount = stats.topQuestions[0].count;
        const pct = Math.round((q.count / maxCount) * 100);
        return `<div class="question-row">
          <span style="color:#aaa;font-size:13px;width:24px">${i+1}</span>
          <span class="question-text">${q.message}</span>
          <div class="bar-container"><div class="bar" style="width:${pct}%"></div></div>
          <span class="question-count">${q.count}x</span>
        </div>`;
      }).join('')
    }
  </div>

  <div class="section">
    <h2>📊 Özet</h2>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
      <div style="background:#f7f8fc;border-radius:12px;padding:16px">
        <div style="font-size:12px;color:#888;margin-bottom:4px">Mesaj Başına Ortalama</div>
        <div style="font-size:24px;font-weight:700;color:#667eea">${stats.totalSessions > 0 ? Math.round(stats.totalMessages / stats.totalSessions) : 0}</div>
        <div style="font-size:12px;color:#aaa">mesaj/konuşma</div>
      </div>
      <div style="background:#f7f8fc;border-radius:12px;padding:16px">
        <div style="font-size:12px;color:#888;margin-bottom:4px">Bugün Oranı</div>
        <div style="font-size:24px;font-weight:700;color:#764ba2">${stats.totalSessions > 0 ? Math.round((stats.todaySessions / stats.totalSessions) * 100) : 0}%</div>
        <div style="font-size:12px;color:#aaa">bugünkü aktivite</div>
      </div>
    </div>
  </div>

  <div style="text-align:center">
    <button class="refresh-btn" onclick="location.reload()">🔄 Yenile</button>
  </div>
</div>
<div class="footer">Chatbot Admin Panel • ${new Date().getFullYear()}</div>
</body>
</html>`);
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
  const { message, sessionId, store } = req.body;

  if (!message || !sessionId) {
    return res.status(400).json({ error: 'message ve sessionId zorunludur.' });
  }

  try {
    resetSessionTimer(sessionId);

    if (!conversations[sessionId]) {
      const products = await shopify.getProducts();
      conversations[sessionId] = [
        { role: 'system', content: buildSystemPrompt(products) }
      ];
    }

    // Önce email bekleniyor mu diye bak
    if (pendingOrderEmail[sessionId]) {
      const email = extractEmail(message);
      if (email) {
        pendingOrderEmail[sessionId] = false;
        const orders = await shopify.getOrdersByEmail(email);

        let orderText;
        if (orders.length === 0) {
          orderText = `${email} adresine ait sipariş bulunamadı.`;
        } else {
          orderText = orders.map(o =>
            `Sipariş #${o.id} | Tarih: ${o.date} | Durum: ${o.fulfillment || 'Hazırlanıyor'} | Kargo Takip: ${o.tracking} | Toplam: ${o.total} | Ürünler: ${o.items.join(', ')}`
          ).join('\n');
        }

        conversations[sessionId].push({ role: 'user', content: `Email: ${email}` });
        conversations[sessionId].push({ role: 'system', content: `Sipariş bilgileri:\n${orderText}` });
        conversations[sessionId].push({ role: 'user', content: 'Bu sipariş bilgilerini müşteriye güzel bir şekilde açıkla.' });

        const reply = await openai.chat(conversations[sessionId]);
        conversations[sessionId].push({ role: 'assistant', content: reply });

        await db.saveMessage(sessionId, 'user', message, store);
        await db.saveMessage(sessionId, 'assistant', reply, store);

        return res.json({ reply });
      }
      // Email gelmedi, normal akışa devam et (AI zaten email isteyecek)
    } else if (isOrderQuery(message)) {
      // Sadece email beklenmiyorken sipariş sorusu geldiyse flag'i set et
      pendingOrderEmail[sessionId] = true;
    }

    conversations[sessionId].push({ role: 'user', content: message });
    const reply = await openai.chat(conversations[sessionId]);
    conversations[sessionId].push({ role: 'assistant', content: reply });

    await db.saveMessage(sessionId, 'user', message, store);
    await db.saveMessage(sessionId, 'assistant', reply, store);

    res.json({ reply });

  } catch (error) {
    console.error('Chat Hatası:', error.message);
    res.status(500).json({ error: 'Bir hata oluştu, lütfen tekrar deneyin.' });
  }
});

// Tek bir listen, db.init() burada
app.listen(process.env.PORT, async () => {
  console.log(`Server ${process.env.PORT} portunda çalışıyor`);
  await db.init().catch(console.error);
});