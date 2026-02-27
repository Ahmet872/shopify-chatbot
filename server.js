const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const shopify = require('./shopify');
const openai = require('./openai');

const conversations = {};

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

app.post('/api/chat', async (req, res) => {
  const { message, sessionId } = req.body;

  try {
    if (!conversations[sessionId]) {
      const products = await shopify.getProducts();
      conversations[sessionId] = [
        {
          role: 'system',
          content: `Sen bir Shopify mağazasının yardımcı asistanısın. 
          Mağazadaki ürünler: ${JSON.stringify(products)}
          Türkçe cevap ver. Ürün sorularında fiyat ve stok bilgisi ver.`
        }
      ];
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