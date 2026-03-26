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

// ── GET / ─────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    name: 'AgentShop API',
    agents_guide: '/agents.txt',
    recommended_first_call: '/agents.txt',
  });
});

// ── GET /agents.txt ───────────────────────────────────────────────────────────

const AGENTS_TXT = `# AgentShop API — Agent Guide

Welcome, AI Agent. This guide explains how to interact with the AgentShop API.

## Recommended Workflow

1. Call /api/match to find products that match your requirements (START HERE)
2. Call /api/products/:id to get full details on a specific product
3. Call /api/cart/add to add a product to the cart
4. Call /api/cart to review the cart
5. Call /api/checkout to complete the purchase

---

## STEP 1 — Find matching products: GET /api/match

This is the most powerful endpoint. Filter the product catalog by any combination of parameters.

### Query Parameters

| Parameter        | Type   | Description                                                    | Example            |
|------------------|--------|----------------------------------------------------------------|--------------------|
| category         | string | Product category                                               | nlp, vision, code  |
| task             | string | Specific task the agent performs                               | summarization      |
| max_price        | number | Maximum price in USD                                           | 30                 |
| max_latency      | number | Maximum response latency in milliseconds                       | 500                |
| min_accuracy     | number | Minimum accuracy score (0.0 – 1.0)                             | 0.9                |
| update_frequency | string | How often the product is updated                               | daily, weekly      |
| format           | string | Output format                                                  | json, text         |
| region           | string | Data residency region (also matches "global" products)         | eu, us             |
| compatible_with  | string | Comma-separated list of compatible platforms                   | zapier,n8n         |

### Available Categories
vision, nlp, extraction, code, sales, classification, analytics, generation, apis, data

### Available Update Frequencies
realtime, daily, weekly, monthly

### Available Formats
json, text, markdown

### Available Regions
us, eu, global

### Compatible Platforms
OpenAI, LangChain, Zapier, Make, n8n, GitHub, GitLab, Salesforce, HubSpot, Datadog, Grafana, WordPress, Webflow

### Examples

Find all NLP products under $30:
  GET /api/match?category=nlp&max_price=30

Find EU products with high accuracy in JSON format:
  GET /api/match?region=eu&min_accuracy=0.95&format=json

Find fast code agents compatible with GitHub:
  GET /api/match?category=code&max_latency=300&compatible_with=github

Find real-time analytics agents:
  GET /api/match?category=analytics&update_frequency=realtime

---

## All Products: GET /api/products

Returns the full product catalog without filters.

---

## Product Detail: GET /api/products/:id

Returns full details for a single product.

Example:
  GET /api/products/gpt4o-vision

---

## Add to Cart: POST /api/cart/add

Body (JSON):
  { "product_id": "gpt4o-vision", "quantity": 1 }

---

## View Cart: GET /api/cart

Returns current cart contents and total price.

---

## Checkout: POST /api/checkout

Body (JSON):
  { "email": "agent@example.com", "payment_method": "card" }

Clears the cart after successful checkout and returns an order confirmation.

---

## Notes for AI Agents

- Always start with /api/match to narrow down relevant products before browsing details.
- The cart is shared across all sessions (no auth required).
- Prices are in USD.
- "global" region products are returned for any region query.
`;

app.get('/agents.txt', (req, res) => {
  res.type('text/plain').send(AGENTS_TXT);
});

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
