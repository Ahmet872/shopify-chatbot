const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
  }
  return pool;
}

async function init() {
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      message TEXT NOT NULL,
      store TEXT DEFAULT 'shopify',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      session_id TEXT UNIQUE NOT NULL,
      store TEXT,
      first_message TEXT,
      message_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('PostgreSQL bağlandı ✓');
}

async function saveMessage(sessionId, role, message, store = 'shopify') {
  const p = getPool();
  await p.query(
    'INSERT INTO conversations (session_id, role, message, store) VALUES ($1, $2, $3, $4)',
    [sessionId, role, message, store]
  );
  await p.query(`
    INSERT INTO sessions (session_id, store, first_message, message_count)
    VALUES ($1, $2, $3, 1)
    ON CONFLICT (session_id) DO UPDATE SET
      message_count = sessions.message_count + 1,
      updated_at = NOW()
  `, [sessionId, store, message]);
}

async function getStats() {
  const p = getPool();
  const totalSessions = await p.query('SELECT COUNT(*) FROM sessions');
  const totalMessages = await p.query('SELECT COUNT(*) FROM conversations');
  const todaySessions = await p.query(`SELECT COUNT(*) FROM sessions WHERE DATE(created_at) = CURRENT_DATE`);
  const topQuestions = await p.query(`
    SELECT message, COUNT(*) as count FROM conversations
    WHERE role = 'user'
    GROUP BY message ORDER BY count DESC LIMIT 5
  `);
  return {
    totalSessions: parseInt(totalSessions.rows[0].count),
    totalMessages: parseInt(totalMessages.rows[0].count),
    todaySessions: parseInt(todaySessions.rows[0].count),
    topQuestions: topQuestions.rows
  };
}

module.exports = { saveMessage, getStats, init };