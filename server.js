// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ---------- CONFIG (set these on Render, not in GitHub) ----------
const PORT = process.env.PORT || 3000;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;         // e.g. myshop.myshopify.com
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;         // Admin API token (private app)
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || ""; // optional webhook to forward forecast
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";

// ---------- Helpers ----------
function isoMonthsAgo(months = 6) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString();
}

async function shopifyFetch(path) {
  const url = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}${path}`;
  const res = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    const err = new Error(`Shopify API error: ${res.status} ${txt}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// fetch orders for a customer by customer_id or email within last 6 months
async function fetchCustomerOrders({ customer_id, email, months = 6 }) {
  // Prefer customer_id if provided (more reliable)
  const created_at_min = encodeURIComponent(isoMonthsAgo(months));
  let path = `/orders.json?status=any&created_at_min=${created_at_min}&limit=250`;
  if (customer_id) path += `&customer_id=${customer_id}`;
  if (email && !customer_id) path += `&email=${encodeURIComponent(email)}`;

  const data = await shopifyFetch(path);
  return data.orders || [];
}

// Aggregate variant quantities across orders
function aggregateLineItems(orders) {
  const map = {}; // variant_id -> { qty, product_title }
  for (const o of orders) {
    if (!o.line_items) continue;
    for (const li of o.line_items) {
      const vid = li.variant_id || li.product_id;
      if (!vid) continue;
      const id = String(vid);
      if (!map[id]) map[id] = { qty: 0, title: li.name || li.title || "" };
      map[id].qty += (li.quantity || 0);
    }
  }
  return map;
}

// Simple rule-based forecast: average monthly qty over `months`
function buildForecastFromAggregates(map, months = 6, topN = 12) {
  const arr = Object.entries(map).map(([variant_id, v]) => {
    const avgPerMonth = v.qty / months;
    let qty = Math.round(avgPerMonth);
    if (v.qty > 0 && qty < 1) qty = 1;
    qty = Math.min(qty, 50); // clamp max
    return { variant_id, qty, title: v.title, totalQty: v.qty };
  });

  // sort by totalQty descending and take top N
  return arr.sort((a, b) => b.totalQty - a.totalQty).slice(0, topN);
}

// Build Shopify cart URL to prefill cart (relative path)
function buildCartUrl(items) {
  // items: [{ variant_id, qty }]
  const parts = items.map(i => `${i.variant_id}:${i.qty}`);
  if (parts.length === 0) return "/cart";
  return `/cart/${parts.join(",")}`;
}

// ---------- Routes ----------

// Health check
app.get("/", (req, res) => res.send("✅ Forecast Assistant running"));

// Forecast endpoint (called from storefront widget)
// Accepts either { customer_id } or { email } in body (or query params for convenience)
app.post("/forecast", async (req, res) => {
  try {
    const customerId = req.body.customer_id || req.query.customer_id;
    const email = req.body.email || req.query.email;

    if (!customerId && !email) {
      return res.status(400).json({ error: "Provide customer_id or email" });
    }

    // 1) Fetch orders for last 6 months
    const orders = await fetchCustomerOrders({ customer_id: customerId, email, months: 6 });

    if (!orders || orders.length === 0) {
      return res.json({ cartUrl: "/cart", message: "No purchases in the last 6 months" });
    }

    // 2) Aggregate and forecast
    const agg = aggregateLineItems(orders);
    const forecastItems = buildForecastFromAggregates(agg, 6, 12); // top 12

    // 3) Validate simple response
    if (!forecastItems.length) {
      return res.json({ cartUrl: "/cart", message: "No forecastable items found" });
    }

    // 4) Build cart url and cache optionally (not implemented here)
    const cartUrl = buildCartUrl(forecastItems);

    // 5) Optionally forward forecast to n8n or analytics
    if (N8N_WEBHOOK_URL) {
      try {
        await fetch(N8N_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            shop: SHOPIFY_STORE,
            customer_id: customerId || null,
            email: email || null,
            forecastItems,
            cartUrl,
            timestamp: new Date().toISOString()
          }),
        });
      } catch (fwErr) {
        console.warn("Warning: failed to forward to N8N:", fwErr.message);
        // do not fail the main response if forwarding fails
      }
    }

    // Return cartUrl + items to frontend
    return res.json({ cartUrl, items: forecastItems });
  } catch (err) {
    console.error("Forecast error:", err);
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || "server_error" });
  }
});

// Optional: cached forecast endpoint (simple GET)
app.get("/forecast/cached", (req, res) => {
  // placeholder - returns 204 for now
  res.status(204).end();
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Forecast Assistant listening on port ${PORT}`);
});
