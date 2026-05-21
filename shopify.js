const axios = require('axios');

function createClient(tenant) {
  return axios.create({
    baseURL: `https://${tenant.shopify_url}/admin/api/2024-01`,
    headers: {
      'X-Shopify-Access-Token': tenant.shopify_token,
      'Content-Type': 'application/json'
    }
  });
}

async function getProducts(tenant) {
  const client = createClient(tenant);
  const response = await client.get('/products.json?limit=20');
  
  return response.data.products.map(p => {
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