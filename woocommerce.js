const axios = require('axios');
const https = require('https');

// GUVENLIK: SSL dogrulamasi artik her zaman kapali degil. Sadece yerel/dev
// ortamlar (deneme.local, localhost, 127.0.0.1, .test) icin self-signed
// sertifika kabul ediliyor -- gercek musteri magazalari (canli WooCommerce
// siteleri) her zaman gecerli sertifika ister. Bu olmadan MITM ile
// wc_key/wc_secret calinabilir.
function isLocalDevUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' ||
           host.endsWith('.local') || host.endsWith('.test');
  } catch (_) {
    return false;
  }
}

function createClient(tenant) {
  const isDev = isLocalDevUrl(tenant.wc_url);
  return axios.create({
    baseURL: `${tenant.wc_url}/wp-json/wc/v3`,
    auth: {
      username: tenant.wc_key,
      password: tenant.wc_secret
    },
    // Sadece dev/local host'larda self-signed sertifikaya izin ver.
    httpsAgent: new https.Agent({ rejectUnauthorized: !isDev })
  });
}

// ─── CONTROLLED CONCURRENCY ───────────────────────────────────────────────────
// Promise.all yerine max N eşzamanlı istek — WC'nin ban atmasını önler.
async function runInBatches(items, batchSize, asyncFn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(asyncFn));
    results.push(...batchResults);
  }
  return results;
}

// WooCommerce sayfa numarası tabanlı sayfalama kullanır (?page=N). Shopify'daki
// gibi tüm katalog LLM system promptuna JSON olarak gömüldüğü için burada da
// aynı MAX_PRODUCTS üst sınırını uyguluyoruz — bkz. shopify.js'deki not.
async function fetchAllProducts(client) {
  const PER_PAGE = 100;      // WooCommerce'in izin verdiği maksimum
  const MAX_PAGES = 20;      // sonsuz döngü riskine karşı mutlak üst sınır
  const MAX_PRODUCTS = 200;  // pratik üst sınır — prompt boyutunu makul tutar

  let products = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await client.get(`/products?per_page=${PER_PAGE}&status=publish&page=${page}`);
    if (!response.data.length) break;

    products = products.concat(response.data);
    if (products.length >= MAX_PRODUCTS) {
      products = products.slice(0, MAX_PRODUCTS);
      break;
    }
    if (response.data.length < PER_PAGE) break; // son sayfaya ulaşıldı
  }
  return products;
}

async function getProducts(tenant) {
  const client = createClient(tenant);

  // Ana ürünleri çek (tüm sayfalar, üst sınıra kadar)
  const rawProducts = await fetchAllProducts(client);

  // ─── ESKİ KOD: await Promise.all(response.data.map(async p => { ... }))
  // Bu 20 ürün × varyasyon = 20 eşzamanlı istek açardı — bazı WC siteleri ban atar.
  // YENİ: 3'lü batch — her batch bittikten sonra sıradakini başlat.
  const products = await runInBatches(rawProducts, 3, async (p) => {
    // Açıklamayı temizle (HTML taglari)
    const description = p.description
      ? p.description.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().substring(0, 500)
      : (p.short_description
          ? p.short_description.replace(/<[^>]*>/g, '').trim().substring(0, 300)
          : null);

    // Görsel — WC images array'inin ilk elemanı
    const image = p.images?.[0]?.src || null;

    // Basit ürün (varyasyonsuz)
    if (p.type === 'simple') {
      return {
        id: p.id,
        title: p.name,
        description,
        price: p.price || p.regular_price,
        stock: p.stock_quantity ?? (p.in_stock ? 99 : 0),
        image,
        options: [],
        variants: [],
        total_stock: p.stock_quantity ?? (p.in_stock ? 99 : 0),
        category: p.categories?.[0]?.name || ''
      };
    }

    // Varyasyonlu ürün — WooCommerce /variations alt endpoint
    let variants = [];
    let options = [];
    try {
      const varRes = await client.get(`/products/${p.id}/variations?per_page=50`);
      variants = varRes.data.map(v => ({
        id: v.id,
        title: v.attributes.map(a => a.option).join(' / '),  // "XL / Kirmizi"
        price: v.price || v.regular_price,
        stock: v.stock_quantity ?? (v.in_stock ? 99 : 0),
        sku: v.sku || null
      }));

      // Benzersiz seçenek gruplarini çikar (Beden, Renk vb.)
      const attrMap = {};
      varRes.data.forEach(v => {
        v.attributes.forEach(a => {
          if (!attrMap[a.name]) attrMap[a.name] = new Set();
          attrMap[a.name].add(a.option);
        });
      });
      options = Object.entries(attrMap).map(([name, vals]) => ({
        name,
        values: Array.from(vals)
      }));
    } catch (_) {
      // Varyasyon çekme basarisiz — boş birak, ürün yine gösterilir
    }

    const total_stock = variants.length
      ? variants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0)
      : (p.stock_quantity ?? (p.in_stock ? 99 : 0));

    return {
      id: p.id,
      title: p.name,
      description,
      price: p.price || p.regular_price,
      stock: p.stock_quantity ?? (p.in_stock ? 99 : 0),
      image,
      options,
      variants,
      total_stock,
      category: p.categories?.[0]?.name || ''
    };
  });

  return products;
}

async function getOrdersByEmail(tenant, email) {
  const client = createClient(tenant);
  const response = await client.get(`/orders?search=${email}&per_page=5`);
  return response.data.map(o => ({
    id: o.number,
    date: o.date_created?.split('T')[0],
    status: o.status,
    fulfillment: o.status,  // WC'de ayri fulfillment yok, status kullan
    total: o.total,
    tracking: o.meta_data?.find(m => m.key === '_tracking_number')?.value || 'Henüz yok',
    items: o.line_items.map(i => i.name)
  }));
}

module.exports = { getProducts, getOrdersByEmail };