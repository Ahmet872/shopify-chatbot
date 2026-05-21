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
  const response = await client.get('/products?per_page=10&status=publish');
  return response.data.map(p => ({
    id: p.id,
    title: p.name,
    price: p.price,
    stock: p.stock_quantity,
    category: p.categories?.[0]?.name || ''
  }));
}

async function getOrdersByEmail(tenant, email) {
  const client = createClient(tenant);
  const response = await client.get(`/orders?search=${email}&per_page=5`);
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