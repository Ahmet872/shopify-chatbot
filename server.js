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

function extractEmail(text) {
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : null;
}

function isOrderQuery(text) {
  const keywords = ['sipariş', 'kargo', 'takip', 'nerede', 'gelmedi', 'ne zaman gelecek'];
  return keywords.some(k => text.toLowerCase().includes(k));
}

function buildSystemPrompt(products) {
  return `Sen ${process.env.STORE_NAME} mağazasının yapay zeka destekli müşteri hizmetleri asistanısın.

GENEL KURALLAR:
- Her zaman ${process.env.STORE_LANGUAGE} konuş, müşteri başka dilde yazsa bile
- Nazik, samimi ve yardımsever ol
- Kısa ve net cevaplar ver, gereksiz uzatma
- Emoji kullanabilirsin ama abartma

MAĞAZA BİLGİLERİ:
- Mağaza adı: ${process.env.STORE_NAME}
- Kargo süresi: ${process.env.SHIPPING_DAYS} iş günü
- Kargo firması: ${process.env.SHIPPING_COMPANY}
- İade süresi: Teslimattan itibaren ${process.env.RETURN_DAYS} gün
- WhatsApp destek: ${process.env.WHATSAPP_NUMBER}

ÜRÜNLER (anlık stok ve fiyat):
${JSON.stringify(products)}

YAPMAN GEREKENLER:
- Ürün sorusunda fiyat, stok ve özellik bilgisi ver
- Sipariş sorusunda email adresini iste, email gelince siparişi sorgula
- İade/değişim sorusunda ${process.env.RETURN_DAYS} günlük politikayı anlat
- Kargo sorusunda ${process.env.SHIPPING_DAYS} iş günü ve ${process.env.SHIPPING_COMPANY} bilgisini ver
- Çözemediğin sorularda WhatsApp'a yönlendir: ${process.env.WHATSAPP_NUMBER}
- "200TL altında ürün var mı?" gibi fiyat filtreli sorulara ürün listesinden bakarak cevap ver
- Müşteri sinirli veya şikayet ediyorsa özür dile ve WhatsApp'a yönlendir

YAPMAMAN GEREKENLER:
- Mağazanın sahip olmadığı ürün veya hizmeti uydurma
- Kesin teslimat tarihi verme, hep "yaklaşık" de
- Başka mağaza veya rakip önerme`;
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

// İstatistik endpoint - ileride admin paneli için
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

  try {
    if (!conversations[sessionId]) {
      const products = await shopify.getProducts();
      conversations[sessionId] = [
        {
          role: 'system',
          content: buildSystemPrompt(products)
        }
      ];
    }

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

        db.saveMessage(sessionId, 'user', message, store);
        db.saveMessage(sessionId, 'assistant', reply, store);

        return res.json({ reply });
      }
    }

    if (isOrderQuery(message)) {
      pendingOrderEmail[sessionId] = true;
    }

    conversations[sessionId].push({ role: 'user', content: message });
    const reply = await openai.chat(conversations[sessionId]);
    conversations[sessionId].push({ role: 'assistant', content: reply });

    db.saveMessage(sessionId, 'user', message, store);
    db.saveMessage(sessionId, 'assistant', reply, store);

    res.json({ reply });

  } catch (error) {
    console.error('Chat Hatası:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(process.env.PORT, () => {
  console.log(`Server ${process.env.PORT} portunda çalışıyor`);
});

app.listen(process.env.PORT, () => {
  console.log(`Server ${process.env.PORT} portunda çalışıyor`);
});