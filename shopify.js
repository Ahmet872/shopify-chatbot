const axios = require('axios');

function createClient(tenant) {
  return axios.create({
    baseURL: `https://${tenant.shopify_url}/admin/api/2026-07`, // Guncel stabil surum -- eskisi (2024-01) suresi dolmus, sessizce farkli bir surume dusuyordu
    headers: {
      'X-Shopify-Access-Token': tenant.shopify_token,
      'Content-Type': 'application/json'
    }
  });
}

// Shopify cursor-tabanlı sayfalama kullanır (page_info), offset/page numarası
// değil. Sonraki sayfa Link header'ında "rel=next" olarak gelir.
// GÜVENLİK/DAYANIKLILIK: sınırsız döngüye girmemek için MAX_PAGES ile üst
// sınır koyduk — çok büyük kataloglarda bile makul sürede biter, sistem
// promptu da aşırı büyümez.
function parseNextPageInfo(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.split(',').find(part => part.includes('rel="next"'));
  if (!match) return null;
  const urlMatch = match.match(/<([^>]+)>/);
  if (!urlMatch) return null;
  const pageInfo = new URL(urlMatch[1]).searchParams.get('page_info');
  return pageInfo || null;
}

// NOT: Tüm ürün kataloğu systemprompt.js'de JSON olarak LLM'e gömülüyor.
// Bu yüzden sayfalamayı sınırsız açmak yerine MAX_PRODUCTS ile makul bir
// üst sınır koyuyoruz — yoksa büyük katalogda system prompt devasa büyür,
// hem OpenAI maliyeti hem de context limiti sorun olur. 200 ürün çoğu KOBİ
// mağazası için yeterli; daha büyük kataloglar için ürünleri LLM'e tamamen
// gömmek yerine arama/RAG tabanlı bir yaklaşım gerekir (ayrı bir konu).
async function fetchAllProducts(tenant) {
  const client = createClient(tenant);
  const PER_PAGE = 250;        // Shopify'ın izin verdiği maksimum
  const MAX_PAGES = 20;        // sonsuz döngü riskine karşı mutlak üst sınır
  const MAX_PRODUCTS = 200;    // pratik üst sınır — prompt boyutunu makul tutar

  let products = [];
  let pageInfo = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const query = pageInfo
      ? `/products.json?limit=${PER_PAGE}&page_info=${pageInfo}`
      : `/products.json?limit=${PER_PAGE}`;
    const response = await client.get(query);
    products = products.concat(response.data.products);

    if (products.length >= MAX_PRODUCTS) {
      products = products.slice(0, MAX_PRODUCTS);
      break;
    }

    pageInfo = parseNextPageInfo(response.headers.link);
    if (!pageInfo) break;
  }

  return products;
}

async function getProducts(tenant) {
  const rawProducts = await fetchAllProducts(tenant);

  return rawProducts.map(p => {
    // Varyantları işle
    const variants = p.variants.map(v => ({
      id: v.id,
      title: v.title,           // "XL / Kırmızı" gibi
      price: v.price,
      stock: v.inventory_quantity,
      sku: v.sku || null
    }));

    // Benzersiz seçenekleri çıkar (beden, renk vb.)
    const options = p.options.map(o => ({
      name: o.name,             // "Beden", "Renk"
      values: o.values          // ["S", "M", "L", "XL"]
    }));

    // Açıklamayı temizle (HTML taglarını sil)
    const description = p.body_html
      ? p.body_html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().substring(0, 500)
      : null;

    return {
      id: p.id,
      title: p.title,
      description: description,
      price: p.variants[0].price,        // Ana fiyat
      stock: p.variants[0].inventory_quantity,
      image: p.images?.[0]?.src || null,
      options: options,                   // Beden/renk seçenekleri
      variants: variants,                 // Tüm varyantlar stok/fiyat ile
      total_stock: p.variants.reduce((sum, v) => sum + (v.inventory_quantity || 0), 0)
    };
  });
}

async function getOrdersByEmail(tenant, email) {
  const client = createClient(tenant);
  const response = await client.get(`/orders.json?email=${email}&status=any&limit=5`);
  return response.data.orders.map(o => ({
    id: o.order_number,
    date: o.created_at.split('T')[0],
    status: o.financial_status,
    fulfillment: o.fulfillment_status,
    total: o.total_price,
    tracking: o.fulfillments?.[0]?.tracking_number || 'Henüz yok',
    items: o.line_items.map(i => i.name)
  }));
}

module.exports = { getProducts, getOrdersByEmail };