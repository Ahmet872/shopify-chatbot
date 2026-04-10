const axios = require('axios');
require('dotenv').config();

const shopifyClient = axios.create({
  baseURL: `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-01`,
  headers: {
    'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
    'Content-Type': 'application/json'
  }
});

async function getProducts() {
  const response = await shopifyClient.get('/products.json?limit=10');
  return response.data.products.map(p => ({
    id: p.id,
    title: p.title,
    price: p.variants[0].price,
    stock: p.variants[0].inventory_quantity,
    image: p.images?.[0]?.src || null
  }));
}

async function getOrdersByEmail(email) {
  const response = await shopifyClient.get(`/orders.json?email=${email}&status=any&limit=5`);
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