const axios = require('axios');
require('dotenv').config();

const wooClient = axios.create({
  baseURL: `${process.env.WC_URL}/wp-json/wc/v3`,
  auth: {
    username: process.env.WC_KEY,
    password: process.env.WC_SECRET
  },
  httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
});

async function getProducts() {
  const response = await wooClient.get('/products?per_page=10&status=publish');
  return response.data.map(p => ({
    id: p.id,
    title: p.name,
    price: p.price,
    stock: p.stock_quantity,
    category: p.categories?.[0]?.name || ''
  }));
}

async function getOrdersByEmail(email) {
  const response = await wooClient.get(`/orders?search=${email}&per_page=5`);
  return response.data.map(o => ({
    id: o.number,
    date: o.date_created?.split('T')[0],
    status: o.status,
    total: o.total,
    tracking: o.meta_data?.find(m => m.key === '_tracking_number')?.value || 'Henüz yok',
    items: o.line_items.map(i => i.name)
  }));
}

module.exports = { getProducts, getOrdersByEmail };