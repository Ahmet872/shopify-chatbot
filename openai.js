const OpenAI = require('openai');
require('dotenv').config();

function getClient(tenant = null) {
  const apiKey = tenant?.openai_key || process.env.OPENAI_API_KEY;
  return new OpenAI({ apiKey });
}

async function chat(messages, tenant = null) {
  const client = getClient(tenant);
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: messages,
    max_tokens: 1000
  });
  return response.choices[0].message.content;
}

module.exports = { chat };