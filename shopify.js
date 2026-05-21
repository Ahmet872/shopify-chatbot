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
  const response = await client.get('/products.json?limit=10');
  return response.data.products.map(p => ({
    id: p.id,
    title: p.title,
    price: p.variants[0].price,
    stock: p.variants[0].inventory_quantity,
    image: p.images?.[0]?.src || null
  }));
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