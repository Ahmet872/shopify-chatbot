const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const shopify = require('./shopify');
const openai = require('./openai');

const conversations = {};
const pendingOrderEmail = {}; // email beklenen sessionlar

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

// Email içeriyor mu kontrol
function extractEmail(text) {
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : null;
}

// Sipariş sorusu mu kontrol
function isOrderQuery(text) {
  const keywords = ['sipariş', 'kargo', 'takip', 'nerede', 'gelmedi', 'ne zaman gelecek'];
  return keywords.some(k => text.toLowerCase().includes(k));
}

app.post('/api/chat', async (req, res) => {
  const { message, sessionId } = req.body;

  try {
    // Konuşma yoksa ürünleri çek, sistemi kur
    if (!conversations[sessionId]) {
      const products = await shopify.getProducts();
      conversations[sessionId] = [
        {
          role: 'system',
          content: `Sen bir Shopify mağazasının yardımcı asistanısın.
Mağazadaki ürünler: ${JSON.stringify(products)}
Türkçe cevap ver. Ürün sorularında fiyat ve stok bilgisi ver.
Müşteri sipariş sorarsa email adresini iste. Email gelince sipariş bilgisini göster.`
        }
      ];
    }

    // Önceki mesajda email bekliyorduk ve şimdi email geldi mi?
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
            `Sipariş #${o.id} | Tarih: ${o.date} | Durum: ${o.fulfillment || 'Hazırlanıyor'} | Kargo Takip: ${o.tracking} | Toplam: ${o.total}₺ | Ürünler: ${o.items.join(', ')}`
          ).join('\n');
        }

        conversations[sessionId].push({ role: 'user', content: `Email: ${email}` });
        conversations[sessionId].push({ role: 'system', content: `Sipariş bilgileri:\n${orderText}` });
        conversations[sessionId].push({ role: 'user', content: 'Bu sipariş bilgilerini müşteriye güzel bir şekilde açıkla.' });

        const reply = await openai.chat(conversations[sessionId]);
        conversations[sessionId].push({ role: 'assistant', content: reply });
        return res.json({ reply });
      }
    }

    // Sipariş sorusu mu?
    if (isOrderQuery(message)) {
      pendingOrderEmail[sessionId] = true;
    }

    conversations[sessionId].push({ role: 'user', content: message });
    const reply = await openai.chat(conversations[sessionId]);
    conversations[sessionId].push({ role: 'assistant', content: reply });

    res.json({ reply });

  } catch (error) {
    console.error('Chat Hatası:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(process.env.PORT, () => {
  console.log(`Server ${process.env.PORT} portunda çalışıyor`);
});