const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Security Middleware ───────────────────────────────────────────────────────

// Security headers (X-Frame-Options, X-Content-Type-Options, CSP, etc.)
app.use(helmet());

// CORS – restrict to allowed origins via ALLOWED_ORIGIN env var
// Set ALLOWED_ORIGIN=https://yourfrontend.com in production
// Multiple origins: ALLOWED_ORIGIN=https://a.com,https://b.com
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const corsOrigin = ALLOWED_ORIGIN === '*' ? '*' : ALLOWED_ORIGIN.split(',').map(o => o.trim());
app.use(cors({
  origin: corsOrigin,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));

// Rate limiting – 100 requests per 15 minutes per IP
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests – please try again later.' },
}));

// Body parsing with 10 KB size limit to prevent large payload attacks
app.use(express.json({ limit: '10kb' }));

// ── Input Validation Helpers ─────────────────────────────────────────────────

function parseNonNegativeFloat(val, name, max) {
  const n = parseFloat(val);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  if (max !== undefined && n > max) {
    throw new Error(`${name} must not exceed ${max}.`);
  }
  return n;
}

function parsePositiveInt(val, name, max) {
  if (!/^\d+$/.test(String(val).trim())) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  const n = parseInt(val, 10);
  if (max !== undefined && n > max) {
    throw new Error(`${name} must not exceed ${max}.`);
  }
  return n;
}

// Simple email sanity check – no external library needed
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

// Allowed enum values for string filter params
const VALID_CATEGORIES = new Set(['vision','nlp','extraction','code','sales','classification','analytics','generation','apis','data']);
const VALID_UPDATE_FREQUENCIES = new Set(['realtime','daily','weekly','monthly']);
const VALID_FORMATS = new Set(['json','text','markdown']);
const VALID_REGIONS = new Set(['us','eu','de','global']);

// ── Data ─────────────────────────────────────────────────────────────────────

function loadProducts() {
  const filePath = path.join(__dirname, 'data', 'products.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// ── Destatis Live-Data via DBnomics ───────────────────────────────────────────

const DBNOMICS_BASE = 'https://api.db.nomics.world/v22';

const DESTATIS_LIVE_PRODUCTS = {
  'destatis-ecommerce-index': {
    url: `${DBNOMICS_BASE}/series/DESTATIS/45212BM002?observations=true&limit=200`,
    transform(docs) {
      const WANTED_WZ = new Set(['WZ08-4791', 'WZ08-47911', 'WZ08-47919']);
      return docs
        .filter(s => WANTED_WZ.has(s.dimensions?.WZ08E6))
        .map(s => ({
          series_code:  s.series_code,
          series_name:  s.series_name,
          price_type:   s.dimensions?.WERTE4 === 'NOMINAL' ? 'nominal' : 'real_index_2015_100',
          wz08_code:    s.dimensions?.WZ08E6,
          unit:         'Index (2015 = 100)',
          observations: buildObs(s),
        }));
    },
  },
  'destatis-cpi-categories': {
    url: `${DBNOMICS_BASE}/series/DESTATIS/61111BM003?observations=true&limit=100`,
    transform(docs) {
      const CATEGORY_LABELS = {
        'CC13-011': 'Food',
        'CC13-031': 'Clothing',
        'CC13-032': 'Footwear',
        'CC13-051': 'Furniture & lighting',
        'CC13-053': 'Household appliances',
        'CC13-082': 'Telecommunications',
        'CC13-091': 'Audio, video & IT equipment',
        'CC13-095': 'Books & stationery',
      };
      return docs.map(s => ({
        series_code:    s.series_code,
        series_name:    s.series_name,
        coicop_code:    s.dimensions?.CC13A3,
        category_label: CATEGORY_LABELS[s.dimensions?.CC13A3] ?? s.dimensions?.CC13A3,
        unit:           'Index (2020 = 100)',
        observations:   buildObs(s),
      }));
    },
  },
};

function buildObs(series) {
  const periods = series.period ?? [];
  const values  = series.value  ?? [];
  return periods.map((p, i) => ({ period: p, value: values[i] ?? null }));
}

async function fetchDestatisLiveData(productId) {
  const config = DESTATIS_LIVE_PRODUCTS[productId];
  if (!config) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const resp = await fetch(config.url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`DBnomics HTTP ${resp.status}`);
    const json = await resp.json();
    const docs  = json?.series?.docs ?? [];
    return {
      source:       '© Statistisches Bundesamt (Destatis), Datenlizenz Deutschland 2.0',
      dataset:      json?.series?.docs?.[0]?.dataset_code ?? productId,
      retrieved_at: new Date().toISOString(),
      series:       config.transform(docs),
    };
  } finally {
    clearTimeout(timer);
  }
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

// ── GET /openapi.json ─────────────────────────────────────────────────────────

app.get('/openapi.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'openapi.json'));
});

// ── GET /agents.txt ───────────────────────────────────────────────────────────

const AGENTS_TXT = `# AgentShop API — Agent Guide

api_base: https://api.agentdata.shop/api

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
  GET https://api.agentdata.shop/api/match?category=nlp&max_price=30

Find EU products with high accuracy in JSON format:
  GET https://api.agentdata.shop/api/match?region=eu&min_accuracy=0.95&format=json

Find fast code agents compatible with GitHub:
  GET https://api.agentdata.shop/api/match?category=code&max_latency=300&compatible_with=github

Find real-time analytics agents:
  GET https://api.agentdata.shop/api/match?category=analytics&update_frequency=realtime

---

## All Products: GET /api/products

Returns the full product catalog without filters.

---

## Product Detail: GET /api/products/:id

Returns full details for a single product.

Example:
  GET https://api.agentdata.shop/api/products/gpt4o-vision

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

app.get('/api/products/:id', async (req, res) => {
  // Validate id format – only alphanumeric and hyphens allowed
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(req.params.id)) {
    return res.status(400).json({ success: false, error: 'Invalid product id format.' });
  }
  const products = loadProducts();
  const product = products.find(p => p.id === req.params.id);
  if (!product) {
    return res.status(404).json({ success: false, error: 'Product not found.' });
  }

  // For live-data products: include a small preview (last 6 observations per series)
  if (DESTATIS_LIVE_PRODUCTS[product.id]) {
    try {
      const liveData = await fetchDestatisLiveData(product.id);
      const preview = liveData
        ? {
            ...liveData,
            series: liveData.series.map(s => ({
              ...s,
              observations: s.observations.slice(-6),
              note: 'Preview – last 6 months. Full dataset delivered on purchase.',
            })),
          }
        : null;
      return res.json({ success: true, data: product, data_preview: preview });
    } catch {
      // DBnomics unreachable – return product without preview
      return res.json({ success: true, data: product, data_preview: null });
    }
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

  try {
    if (category !== undefined) {
      if (!VALID_CATEGORIES.has(category)) {
        return res.status(400).json({ success: false, error: `Invalid category. Allowed: ${[...VALID_CATEGORIES].join(', ')}.` });
      }
      products = products.filter(p => p.category === category);
    }

    if (task !== undefined) {
      if (typeof task !== 'string' || task.length > 100) {
        return res.status(400).json({ success: false, error: 'task must be a string up to 100 characters.' });
      }
      products = products.filter(p => p.task === task);
    }

    if (max_price !== undefined) {
      const price = parseNonNegativeFloat(max_price, 'max_price', 1_000_000);
      products = products.filter(p => p.price <= price);
    }

    if (max_latency !== undefined) {
      const latency = parsePositiveInt(max_latency, 'max_latency', 600_000);
      products = products.filter(p => p.latency_ms <= latency);
    }

    if (min_accuracy !== undefined) {
      const accuracy = parseNonNegativeFloat(min_accuracy, 'min_accuracy', 1);
      products = products.filter(p => p.accuracy >= accuracy);
    }

    if (update_frequency !== undefined) {
      if (!VALID_UPDATE_FREQUENCIES.has(update_frequency)) {
        return res.status(400).json({ success: false, error: `Invalid update_frequency. Allowed: ${[...VALID_UPDATE_FREQUENCIES].join(', ')}.` });
      }
      products = products.filter(p => p.update_frequency === update_frequency);
    }

    if (format !== undefined) {
      if (!VALID_FORMATS.has(format)) {
        return res.status(400).json({ success: false, error: `Invalid format. Allowed: ${[...VALID_FORMATS].join(', ')}.` });
      }
      products = products.filter(p => p.format === format);
    }

    if (region !== undefined) {
      if (!VALID_REGIONS.has(region)) {
        return res.status(400).json({ success: false, error: `Invalid region. Allowed: ${[...VALID_REGIONS].join(', ')}.` });
      }
      products = products.filter(p => p.region === region || p.region === 'global');
    }

    if (compatible_with !== undefined) {
      if (typeof compatible_with !== 'string' || compatible_with.length > 200) {
        return res.status(400).json({ success: false, error: 'compatible_with must be a string up to 200 characters.' });
      }
      const tools = compatible_with.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
      if (tools.length === 0 || tools.length > 20) {
        return res.status(400).json({ success: false, error: 'compatible_with must contain 1–20 comma-separated values.' });
      }
      products = products.filter(p =>
        Array.isArray(p.compatible_with) &&
        tools.some(tool => p.compatible_with.map(c => c.toLowerCase()).includes(tool))
      );
    }
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }

  res.json({ success: true, count: products.length, data: products });
});

// ── POST /api/cart/add ────────────────────────────────────────────────────────
// Body: { product_id: string, quantity?: number }

app.post('/api/cart/add', (req, res) => {
  const { product_id, quantity = 1 } = req.body;

  if (!product_id || typeof product_id !== 'string') {
    return res.status(400).json({ success: false, error: 'product_id is required.' });
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(product_id)) {
    return res.status(400).json({ success: false, error: 'Invalid product_id format.' });
  }

  let qty;
  try {
    qty = parsePositiveInt(String(quantity), 'quantity', 100);
    if (qty < 1) throw new Error('quantity must be at least 1.');
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }

  const products = loadProducts();
  const product = products.find(p => p.id === product_id);
  if (!product) {
    return res.status(404).json({ success: false, error: 'Product not found.' });
  }

  const existing = cart.find(item => item.product_id === product_id);
  if (existing) {
    existing.quantity += qty;
  } else {
    cart.push({ product_id, name: product.name, price: product.price, quantity: qty });
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

app.post('/api/checkout', async (req, res) => {
  if (cart.length === 0) {
    return res.status(400).json({ success: false, error: 'Cart is empty.' });
  }

  const { email, payment_method = 'card' } = req.body;

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ success: false, error: 'email is required.' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ success: false, error: 'Invalid email address.' });
  }
  if (email.length > 320) {
    return res.status(400).json({ success: false, error: 'email too long.' });
  }

  const VALID_PAYMENT_METHODS = new Set(['card', 'paypal', 'crypto']);
  const method = String(payment_method);
  if (!VALID_PAYMENT_METHODS.has(method)) {
    return res.status(400).json({ success: false, error: `Invalid payment_method. Allowed: ${[...VALID_PAYMENT_METHODS].join(', ')}.` });
  }

  const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const purchasedItems = [...cart];

  // Clear cart before async work so parallel checkouts don't double-clear
  cart.length = 0;

  // Fetch live data for every Destatis product in the order
  const liveDataResults = await Promise.all(
    purchasedItems
      .filter(item => DESTATIS_LIVE_PRODUCTS[item.product_id])
      .map(async item => {
        try {
          const data = await fetchDestatisLiveData(item.product_id);
          return { product_id: item.product_id, data };
        } catch (e) {
          console.error('Destatis live-data fetch failed for', item.product_id, '–', e?.message);
          return { product_id: item.product_id, data: null, error: 'Live data temporarily unavailable.' };
        }
      })
  );

  const live_data = liveDataResults.length > 0 ? liveDataResults : undefined;

  const order = {
    order_id: `ord_${Date.now()}`,
    email,
    payment_method: method,
    items: purchasedItems,
    total: Math.round(total * 100) / 100,
    status: 'confirmed',
    created_at: new Date().toISOString(),
  };

  res.json({
    success: true,
    message: 'Order placed successfully.',
    order,
    ...(live_data && { live_data }),
  });
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
