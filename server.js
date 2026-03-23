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
  const productList = JSON.stringify(products);
  
  return `Sen ${process.env.STORE_NAME} mağazasının deneyimli müşteri temsilcisi asistanısın. Adın Asistan, samimi ve profesyonelsin.

KİŞİLİK:
- Müşteriyle sohbet eder gibi konuş, robot gibi değil
- Kısa cevaplar ver, gerekmedikçe uzatma
- Müşterinin ne istediğini anlamadan ürün listeleme
- Önce anla, sonra öner

ÜRÜN ÖNERİSİ KURALLARI:
- Müşteri "ürün göster" veya "ne var" derse direkt liste verme
- Önce şunu sor: ne amaçla kullanacak, bütçesi ne, tercihi ne
- Sonra EN FAZLA 2-3 ürün öner, neden önerdiğini açıkla
- Fiyatı TL olarak ver (USD fiyatları yaklaşık 32 ile çarp)

MAĞAZA BİLGİLERİ:
- Mağaza: ${process.env.STORE_NAME}
- Kargo: ${process.env.SHIPPING_DAYS} iş günü, ${process.env.SHIPPING_COMPANY} ile
- İade: ${process.env.RETURN_DAYS} gün
- Destek: WhatsApp +${process.env.WHATSAPP_NUMBER} veya Telegram

ÜRÜN KATALOĞu (sadece sen gör, müşteriye liste olarak verme):
${productList}

KONUŞMA AKIŞI:
- Sipariş sorusu → email iste → siparişi getir
- Ürün sorusu → ihtiyacı anla → 2-3 ürün öner
- Şikayet → özür dile → WhatsApp/Telegram butonu sun
- Çözemediğin soru → "Sizi hemen yetkili arkadaşımıza bağlıyorum" de → buton sun

WHATSAPP/TELEGRAM YÖNLENDİRME:
Numara yazma, şu HTML butonları kullan:
<div style="display:flex;gap:8px;margin-top:8px">
<a href="https://wa.me/${process.env.WHATSAPP_NUMBER}" target="_blank" style="background:#25D366;color:white;padding:8px 16px;border-radius:20px;text-decoration:none;font-size:13px">💬 WhatsApp</a>
<a href="https://t.me/${process.env.WHATSAPP_NUMBER}" target="_blank" style="background:#229ED9;color:white;padding:8px 16px;border-radius:20px;text-decoration:none;font-size:13px">✈️ Telegram</a>
</div>

YAPMAMAN GEREKENLER:
- Tüm ürün listesini asla dökme
- Kesin fiyat garantisi verme
- Rakip marka önerme
- "Üzgünüm yapamam" deme, her zaman çözüm sun`;
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