const axios = require('axios');
const https = require('https');

function createClient(tenant) {
  return axios.create({
    baseURL: `${tenant.wc_url}/wp-json/wc/v3`,
    auth: {
      username: tenant.wc_key,
      password: tenant.wc_secret
    },
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
  });
}

async function getProducts(tenant) {
  const client = createClient(tenant);

  // Ana ürünleri çek
  const response = await client.get('/products?per_page=20&status=publish');

  const products = await Promise.all(response.data.map(async p => {
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
  }));

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