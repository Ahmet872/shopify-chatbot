const OpenAI = require('openai');
require('dotenv').config();

function getClient(tenant = null) {
  const apiKey = tenant?.openai_key || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OpenAI API key bulunamadı.');
  return new OpenAI({ apiKey });
}

// Üstel geri çekilme ile yeniden deneme
// maxRetries: sadece geçici hatalar (429, 5xx, timeout) için tekrar dener
async function chat(messages, tenant = null, maxRetries = 2) {
  const client = getClient(tenant);
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: messages,
        max_tokens: 1000
      });
      return response.choices[0].message.content;
    } catch (err) {
      lastError = err;

      const status = err.status || err.response?.status;
      const isRetryable = status === 429 || status >= 500 || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET';

      // 401/403 → API key hatası, yeniden deneme anlamsız
      if (!isRetryable || attempt === maxRetries) break;

      // Üstel bekleme: 1s, 2s
      const waitMs = Math.pow(2, attempt) * 1000;
      console.warn(`[OpenAI] Deneme ${attempt + 1} başarısız (${status || err.code}), ${waitMs}ms beklenip tekrar denenecek.`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  // Tüm denemeler başarısız → hatayı yukarı fırlat (server.js yakalar)
  throw lastError;
}

module.exports = { chat };