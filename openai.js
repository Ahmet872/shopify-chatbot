const OpenAI = require('openai');
require('dotenv').config();

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function chat(messages) {
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: messages
  });
  return response.choices[0].message.content;
}

module.exports = { chat };