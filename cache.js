// ─── PAYLAŞIMLI CACHE ──────────────────────────────────────────────────────
// Tek instance'da hiçbir şey değişmez: REDIS_URL tanımlı değilse process
// içi Map kullanılır (server.js'deki eski tenantCache/productCache ile
// birebir aynı davranış).
//
// Render'da birden fazla instance/otomatik ölçeklendirme açıldığında her
// instance kendi Map'ini tutar — biri tenant ayarlarını günceller, diğer
// instance'lar 2 dakika boyunca eskisini görmeye devam eder. REDIS_URL
// tanımlanırsa (Render'ın Redis add-on'u gibi) cache tüm instance'lar
// arasında paylaşılır ve bu tutarsızlık ortadan kalkar.
//
// Kurulum: Redis kullanmak istersen `npm install ioredis` ve REDIS_URL
// ortam değişkenini tanımla. Hiçbiri yoksa hiçbir şey yapmana gerek yok.

let redisClient = null;
let redisReady = false;

if (process.env.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    redisClient = new Redis(process.env.REDIS_URL);
    redisClient.on('ready', () => {
      redisReady = true;
      console.log('[Cache] Redis bağlantısı hazır ✓ (paylaşımlı cache aktif)');
    });
    redisClient.on('error', (err) => {
      console.error('[Cache] Redis hatası, bellek içi cache’e düşülüyor:', err.message);
    });
  } catch (err) {
    console.warn('[Cache] REDIS_URL tanımlı ama "ioredis" paketi kurulu değil — bellek içi cache kullanılacak. Kurmak için: npm install ioredis');
  }
}

const memoryStore = new Map();

async function cacheGet(key) {
  if (redisClient && redisReady) {
    try {
      const raw = await redisClient.get(key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.error('[Cache] Redis get hatası, bellek içi cache’e düşülüyor:', err.message);
    }
  }
  const entry = memoryStore.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memoryStore.delete(key);
    return null;
  }
  return entry.value;
}

async function cacheSet(key, value, ttlMs) {
  if (redisClient && redisReady) {
    try {
      await redisClient.set(key, JSON.stringify(value), 'PX', ttlMs);
      return;
    } catch (err) {
      console.error('[Cache] Redis set hatası, bellek içi cache’e düşülüyor:', err.message);
    }
  }
  memoryStore.set(key, { value, expiresAt: Date.now() + ttlMs });
}

async function cacheDel(key) {
  if (redisClient && redisReady) {
    try {
      await redisClient.del(key);
    } catch (err) {
      console.error('[Cache] Redis del hatası:', err.message);
    }
  }
  memoryStore.delete(key);
}

// Prefix ile toplu temizlik — /admin/cache/clear endpoint'i için.
async function cacheClearPrefix(prefix) {
  for (const key of memoryStore.keys()) {
    if (key.startsWith(prefix)) memoryStore.delete(key);
  }
  if (redisClient && redisReady) {
    try {
      const keys = await redisClient.keys(prefix + '*');
      if (keys.length) await redisClient.del(...keys);
    } catch (err) {
      console.error('[Cache] Redis prefix temizleme hatası:', err.message);
    }
  }
}

module.exports = { cacheGet, cacheSet, cacheDel, cacheClearPrefix };