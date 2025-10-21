// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "";
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";

// ---------- HELPERS ----------
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

// Fetch orders for a customer
async function fetchCustomerOrders({ customer_id, email, months = 6 }) {
  const created_at_min = encodeURIComponent(isoMonthsAgo(months));
  let path = `/orders.json?status=any&created_at_min=${created_at_min}&limit=250`;
  if (customer_id) path += `&customer_id=${customer_id}`;
  if (email && !customer_id) path += `&email=${encodeURIComponent(email)}`;
  const data = await shopifyFetch(path);
  return data.orders || [];
}

// Aggregate all line items with monthly breakdown
function aggregateLineItemsWithSeasonality(orders) {
  const map = {};

  for (const o of orders) {
    const month = new Date(o.created_at).getMonth();
    for (const li of o.line_items || []) {
      const vid = String(li.variant_id || li.product_id);
      if (!map[vid]) map[vid] = { title: li.name || li.title || "", totalQty: 0, monthlyQty: {} };
      map[vid].totalQty += li.quantity || 0;
      map[vid].monthlyQty[month] = (map[vid].monthlyQty[month] || 0) + (li.quantity || 0);
    }
  }

  return map;
}

// Build forecast combining recurring + seasonal for current month
function buildForecast(itemsMap, months = 6) {
  const forecast = [];
  const currentMonth = new Date().getMonth();

  for (const [variant_id, data] of Object.entries(itemsMap)) {
    const avgMonthlyQty = data.totalQty / months;
    const regularQty = avgMonthlyQty > 0 ? Math.round(avgMonthlyQty) : 0;
    const seasonalQty = data.monthlyQty[currentMonth] || 0;

    const totalQty = regularQty + seasonalQty;
    if (totalQty > 0) {
      forecast.push({
        variant_id,
        qty: totalQty,
        title: data.title
      });
    }
  }

  return forecast.sort((a, b) => b.qty - a.qty);
}

// Build Shopify cart URL
function buildCartUrl(items) {
  const parts = items.map(i => `${i.variant_id}:${i.qty}`);
  if (parts.length === 0) return "/cart";
  return `/cart/${parts.join(",")}`;
}

// ---------- ROUTES ----------
app.get("/", (req, res) => res.send("✅ Forecast Assistant running"));

app.post("/forecast", async (req, res) => {
  try {
    const customerId = req.body.customer_id || req.query.customer_id;
    const email = req.body.email || req.query.email;

    if (!customerId && !email) return res.status(400).json({ error: "Provide customer_id or email" });

    const orders = await fetchCustomerOrders({ customer_id: customerId, email, months: 6 });
    if (!orders.length) return res.json({ cartUrl: "/cart", items: [] });

    const agg = aggregateLineItemsWithSeasonality(orders);
    const forecastItems = buildForecast(agg, 6);

    const cartUrl = buildCartUrl(forecastItems);

    // Forward to n8n if configured
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
      }
    }

    return res.json({ cartUrl, items: forecastItems });
  } catch (err) {
    console.error("Forecast error:", err);
    return res.status(err.status || 500).json({ error: err.message || "server_error" });
  }
});

// Optional: cached endpoint
app.get("/forecast/cached", (req, res) => res.status(204).end());

app.listen(PORT, () => console.log(`✅ Forecast Assistant listening on port ${PORT}`));
