const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
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
    CREATE TABLE IF NOT EXISTS tenants (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT UNIQUE NOT NULL,
      platform TEXT NOT NULL DEFAULT 'shopify',
      store_name TEXT,
      store_language TEXT DEFAULT 'Türkçe',
      shopify_url TEXT,
      shopify_token TEXT,
      wc_url TEXT,
      wc_key TEXT,
      wc_secret TEXT,
      openai_key TEXT,
      whatsapp TEXT,
      shipping_days TEXT DEFAULT '3-5',
      shipping_company TEXT DEFAULT 'Yurtiçi Kargo',
      return_days TEXT DEFAULT '14',
      admin_password TEXT DEFAULT '1234',
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      message TEXT NOT NULL,
      store TEXT DEFAULT 'shopify',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      session_id TEXT UNIQUE NOT NULL,
      store TEXT,
      first_message TEXT,
      message_count INTEGER DEFAULT 0,
      customer_email TEXT,
      customer_name TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Mevcut tablolara tenant_id kolonu ekle (migration - zaten varsa hata vermez)
  await p.query(`
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS customer_email TEXT;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS customer_name TEXT;
  `).catch(() => {}); // Kolon zaten varsa sessizce geç

  // Leads tablosunu da burada oluştur — ayrı çağırmayı unutma riski yok
  await p.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      session_id TEXT,
      name TEXT,
      email TEXT,
      phone TEXT,
      interested_product TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log('PostgreSQL bağlandı ✓');
}

async function getTenant(tenantId) {
  const p = getPool();
  const result = await p.query(
    'SELECT * FROM tenants WHERE tenant_id = $1 AND active = TRUE',
    [tenantId]
  );
  return result.rows[0] || null;
}

async function getAllTenants() {
  const p = getPool();
  const result = await p.query(
    'SELECT * FROM tenants WHERE active = TRUE ORDER BY created_at ASC'
  );
  return result.rows;
}

async function createTenant(data) {
  const p = getPool();
  // Şifreyi hashle — plain text asla veritabanına yazılmaz
  const rawPassword = data.admin_password || '1234';
  const hashedPassword = await bcrypt.hash(rawPassword, 10);

  const result = await p.query(`
    INSERT INTO tenants (
      tenant_id, platform, store_name, store_language,
      shopify_url, shopify_token,
      wc_url, wc_key, wc_secret,
      openai_key, whatsapp,
      shipping_days, shipping_company, return_days, admin_password
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT (tenant_id) DO UPDATE SET
      platform = EXCLUDED.platform,
      store_name = EXCLUDED.store_name,
      store_language = EXCLUDED.store_language,
      shopify_url = EXCLUDED.shopify_url,
      shopify_token = EXCLUDED.shopify_token,
      wc_url = EXCLUDED.wc_url,
      wc_key = EXCLUDED.wc_key,
      wc_secret = EXCLUDED.wc_secret,
      openai_key = EXCLUDED.openai_key,
      whatsapp = EXCLUDED.whatsapp,
      shipping_days = EXCLUDED.shipping_days,
      shipping_company = EXCLUDED.shipping_company,
      return_days = EXCLUDED.return_days,
      admin_password = EXCLUDED.admin_password
    RETURNING *
  `, [
    data.tenant_id, data.platform, data.store_name, data.store_language || 'Türkçe',
    data.shopify_url || null, data.shopify_token || null,
    data.wc_url || null, data.wc_key || null, data.wc_secret || null,
    data.openai_key || null, data.whatsapp || null,
    data.shipping_days || '3-5', data.shipping_company || 'Yurtiçi Kargo',
    data.return_days || '14', hashedPassword
  ]);
  return result.rows[0];
}

async function saveMessage(tenantId, sessionId, role, message, store = 'shopify') {
  const p = getPool();
  await p.query(
    'INSERT INTO conversations (tenant_id, session_id, role, message, store) VALUES ($1, $2, $3, $4, $5)',
    [tenantId, sessionId, role, message, store]
  );
  await p.query(`
    INSERT INTO sessions (tenant_id, session_id, store, first_message, message_count)
    VALUES ($1, $2, $3, $4, 1)
    ON CONFLICT (session_id) DO UPDATE SET
      message_count = sessions.message_count + 1,
      updated_at = NOW()
  `, [tenantId, sessionId, store, message]);
}

async function getStats(tenantId = null) {
  const p = getPool();

  if (tenantId) {
    const totalSessions = await p.query(
      'SELECT COUNT(*) FROM sessions WHERE tenant_id = $1', [tenantId]
    );
    const totalMessages = await p.query(
      'SELECT COUNT(*) FROM conversations WHERE tenant_id = $1', [tenantId]
    );
    const todaySessions = await p.query(
      'SELECT COUNT(*) FROM sessions WHERE DATE(created_at) = CURRENT_DATE AND tenant_id = $1',
      [tenantId]
    );
    const topQuestions = await p.query(`
      SELECT message, COUNT(*) as count FROM conversations
      WHERE role = 'user' AND tenant_id = $1
      GROUP BY message ORDER BY count DESC LIMIT 5
    `, [tenantId]);

    return {
      totalSessions: parseInt(totalSessions.rows[0].count),
      totalMessages: parseInt(totalMessages.rows[0].count),
      todaySessions: parseInt(todaySessions.rows[0].count),
      topQuestions: topQuestions.rows
    };
  }

  // tenantId yoksa tüm sistem (master admin)
  const totalSessions = await p.query('SELECT COUNT(*) FROM sessions');
  const totalMessages = await p.query('SELECT COUNT(*) FROM conversations');
  const todaySessions = await p.query(
    'SELECT COUNT(*) FROM sessions WHERE DATE(created_at) = CURRENT_DATE'
  );
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

async function getAllSessions(tenantId = null) {
  const p = getPool();
  const filter = tenantId ? `WHERE tenant_id = $1` : '';
  const params = tenantId ? [tenantId] : [];

  const result = await p.query(`
    SELECT session_id, tenant_id, store, first_message, message_count,
           created_at, updated_at, customer_email, customer_name
    FROM sessions
    ${filter}
    ORDER BY updated_at DESC
    LIMIT 50
  `, params);
  return result.rows;
}

async function getSessionMessages(sessionId) {
  const p = getPool();
  const result = await p.query(`
    SELECT role, message, created_at
    FROM conversations
    WHERE session_id = $1
    ORDER BY created_at ASC
  `, [sessionId]);
  return result.rows;
}

async function updateSessionEmail(sessionId, email) {
  const p = getPool();
  await p.query(
    'UPDATE sessions SET customer_email = $1 WHERE session_id = $2',
    [email, sessionId]
  );
}

// Tenant admin şifresini bcrypt ile doğrula
async function verifyAdminPassword(tenant, plainPassword) {
  return bcrypt.compare(plainPassword, tenant.admin_password);
}

// ─── LEADS ────────────────────────────────────────────────────────────────────
async function initLeads() {
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      session_id TEXT,
      name TEXT,
      email TEXT,
      phone TEXT,
      interested_product TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

async function saveLead(tenantId, sessionId, data) {
  const p = getPool();
  await p.query(`
    INSERT INTO leads (tenant_id, session_id, name, email, phone, interested_product, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT DO NOTHING
  `, [tenantId, sessionId, data.name || null, data.email || null, data.phone || null, data.product || null, data.notes || null]);
}

async function getLeads(tenantId) {
  const p = getPool();
  const result = await p.query(`
    SELECT * FROM leads WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100
  `, [tenantId]);
  return result.rows;
}

module.exports = {
  init, getTenant, getAllTenants, createTenant,
  saveMessage, getStats, getAllSessions,
  getSessionMessages, updateSessionEmail,
  verifyAdminPassword, initLeads, saveLead, getLeads
};