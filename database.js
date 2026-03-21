const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'chatbot.db');

let db;

async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }
  db.run(`
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
  save();
  return db;
}

function save() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

async function saveMessage(sessionId, role, message, store = 'shopify') {
  const d = await getDb();
  d.run('INSERT INTO conversations (session_id, role, message) VALUES (?, ?, ?)', [sessionId, role, message]);
  d.run(`
    INSERT INTO sessions (session_id, store, first_message, message_count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(session_id) DO UPDATE SET
      message_count = message_count + 1,
      updated_at = CURRENT_TIMESTAMP
  `, [sessionId, store, message]);
  save();
}

async function getStats() {
  const d = await getDb();
  const totalSessions = d.exec('SELECT COUNT(*) as count FROM sessions')[0]?.values[0][0] || 0;
  const totalMessages = d.exec('SELECT COUNT(*) as count FROM conversations')[0]?.values[0][0] || 0;
  const todaySessions = d.exec(`SELECT COUNT(*) as count FROM sessions WHERE DATE(created_at) = DATE('now')`)[0]?.values[0][0] || 0;
  const topQuestionsResult = d.exec(`
    SELECT message, COUNT(*) as count 
    FROM conversations 
    WHERE role = 'user' 
    GROUP BY message 
    ORDER BY count DESC 
    LIMIT 5
  `);
  const topQuestions = topQuestionsResult[0]?.values.map(r => ({ message: r[0], count: r[1] })) || [];
  return { totalSessions, totalMessages, todaySessions, topQuestions };
}

module.exports = { saveMessage, getStats };