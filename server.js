const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ── Data ─────────────────────────────────────────────────────────────────────

function loadProducts() {
  const filePath = path.join(__dirname, 'data', 'products.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// In-memory cart (keyed by session; simplified: single global cart)
const cart = [];

// ── GET /api/products ─────────────────────────────────────────────────────────

app.get('/api/products', (req, res) => {
  const products = loadProducts();
  res.json({ success: true, count: products.length, data: products });
});

// ── GET /api/products/:id ─────────────────────────────────────────────────────

app.get('/api/products/:id', (req, res) => {
  const products = loadProducts();
  const product = products.find(p => p.id === req.params.id);
  if (!product) {
    return res.status(404).json({ success: false, error: `Product '${req.params.id}' not found.` });
  }
  res.json({ success: true, data: product });
});

// ── GET /api/match ────────────────────────────────────────────────────────────
// Query params: category, task, max_price, max_latency, min_accuracy,
//               update_frequency, format, region, compatible_with

app.get('/api/match', (req, res) => {
  let products = loadProducts();
  const {
    category,
    task,
    max_price,
    max_latency,
    min_accuracy,
    update_frequency,
    format,
    region,
    compatible_with,
  } = req.query;

  if (category) {
    products = products.filter(p => p.category === category);
  }
  if (task) {
    products = products.filter(p => p.task === task);
  }
  if (max_price !== undefined) {
    products = products.filter(p => p.price <= parseFloat(max_price));
  }
  if (max_latency !== undefined) {
    products = products.filter(p => p.latency_ms <= parseInt(max_latency));
  }
  if (min_accuracy !== undefined) {
    products = products.filter(p => p.accuracy >= parseFloat(min_accuracy));
  }
  if (update_frequency) {
    products = products.filter(p => p.update_frequency === update_frequency);
  }
  if (format) {
    products = products.filter(p => p.format === format);
  }
  if (region) {
    products = products.filter(p => p.region === region || p.region === 'global');
  }
  if (compatible_with) {
    const tools = compatible_with.split(',').map(t => t.trim().toLowerCase());
    products = products.filter(p =>
      tools.some(tool => p.compatible_with.map(c => c.toLowerCase()).includes(tool))
    );
  }

  res.json({ success: true, count: products.length, data: products });
});

// ── POST /api/cart/add ────────────────────────────────────────────────────────
// Body: { product_id: string, quantity?: number }

app.post('/api/cart/add', (req, res) => {
  const { product_id, quantity = 1 } = req.body;
  if (!product_id) {
    return res.status(400).json({ success: false, error: 'product_id is required.' });
  }

  const products = loadProducts();
  const product = products.find(p => p.id === product_id);
  if (!product) {
    return res.status(404).json({ success: false, error: `Product '${product_id}' not found.` });
  }

  const existing = cart.find(item => item.product_id === product_id);
  if (existing) {
    existing.quantity += quantity;
  } else {
    cart.push({ product_id, name: product.name, price: product.price, quantity });
  }

  res.json({ success: true, message: 'Product added to cart.', cart });
});

// ── GET /api/cart ─────────────────────────────────────────────────────────────

app.get('/api/cart', (req, res) => {
  const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  res.json({
    success: true,
    items: cart,
    item_count: cart.reduce((sum, item) => sum + item.quantity, 0),
    total: Math.round(total * 100) / 100,
  });
});

// ── POST /api/checkout ────────────────────────────────────────────────────────
// Body: { email: string, payment_method?: string }

app.post('/api/checkout', (req, res) => {
  if (cart.length === 0) {
    return res.status(400).json({ success: false, error: 'Cart is empty.' });
  }

  const { email, payment_method = 'card' } = req.body;
  if (!email) {
    return res.status(400).json({ success: false, error: 'email is required.' });
  }

  const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const order = {
    order_id: `ord_${Date.now()}`,
    email,
    payment_method,
    items: [...cart],
    total: Math.round(total * 100) / 100,
    status: 'confirmed',
    created_at: new Date().toISOString(),
  };

  // Clear cart after checkout
  cart.length = 0;

  res.json({ success: true, message: 'Order placed successfully.', order });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`AgentShop Backend running on http://localhost:${PORT}`);
  console.log('');
  console.log('Endpoints:');
  console.log(`  GET  http://localhost:${PORT}/api/products`);
  console.log(`  GET  http://localhost:${PORT}/api/products/:id`);
  console.log(`  GET  http://localhost:${PORT}/api/match?category=nlp&max_price=30`);
  console.log(`  POST http://localhost:${PORT}/api/cart/add`);
  console.log(`  GET  http://localhost:${PORT}/api/cart`);
  console.log(`  POST http://localhost:${PORT}/api/checkout`);
});
