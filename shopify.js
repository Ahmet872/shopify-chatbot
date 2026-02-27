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
    stock: p.variants[0].inventory_quantity
  }));
}

module.exports = { getProducts };