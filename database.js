const Database = require('better-sqlite3');
const db = new Database('chatbot.db');

// Tabloları oluştur
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT UNIQUE NOT NULL,
    store TEXT,
    first_message TEXT,
    message_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

function saveMessage(sessionId, role, message, store = 'shopify') {
  db.prepare(`
    INSERT INTO conversations (session_id, role, message) VALUES (?, ?, ?)
  `).run(sessionId, role, message);

  db.prepare(`
    INSERT INTO sessions (session_id, store, first_message, message_count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(session_id) DO UPDATE SET
      message_count = message_count + 1,
      updated_at = CURRENT_TIMESTAMP
  `).run(sessionId, store, message);
}

function getStats() {
  return {
    totalSessions: db.prepare('SELECT COUNT(*) as count FROM sessions').get().count,
    totalMessages: db.prepare('SELECT COUNT(*) as count FROM conversations').get().count,
    todaySessions: db.prepare(`
      SELECT COUNT(*) as count FROM sessions 
      WHERE DATE(created_at) = DATE('now')
    `).get().count,
    topQuestions: db.prepare(`
      SELECT message, COUNT(*) as count 
      FROM conversations 
      WHERE role = 'user' 
      GROUP BY message 
      ORDER BY count DESC 
      LIMIT 5
    `).all()
  };
}

function getSessionHistory(sessionId) {
  return db.prepare(`
    SELECT role, message, created_at 
    FROM conversations 
    WHERE session_id = ? 
    ORDER BY created_at ASC
  `).all(sessionId);
}

module.exports = { saveMessage, getStats, getSessionHistory };