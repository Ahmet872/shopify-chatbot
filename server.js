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

app.get('/stats', async (req, res) => {
  try {
    const stats = db.getStats();
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