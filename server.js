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
const TOP_ITEMS = 20; // max items to include in forecast

// ---------- HELPERS ----------
function isoMonthsAgo(months = 6) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString();
}

function isoYearsAgo(years = 2) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
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
async function fetchCustomerOrders({ customer_id, email, months = 6, years = 2 }) {
  const recent_min = encodeURIComponent(isoMonthsAgo(months));
  const seasonal_min = encodeURIComponent(isoYearsAgo(years));
  
  let pathRecent = `/orders.json?status=any&created_at_min=${recent_min}&limit=250`;
  let pathSeasonal = `/orders.json?status=any&created_at_min=${seasonal_min}&limit=250`;

  if (customer_id) {
    pathRecent += `&customer_id=${customer_id}`;
    pathSeasonal += `&customer_id=${customer_id}`;
  }
  if (email && !customer_id) {
    pathRecent += `&email=${encodeURIComponent(email)}`;
    pathSeasonal += `&email=${encodeURIComponent(email)}`;
  }

  const [recentData, seasonalData] = await Promise.all([
    shopifyFetch(pathRecent),
    shopifyFetch(pathSeasonal)
  ]);

  return { 
    recentOrders: recentData.orders || [],
    seasonalOrders: seasonalData.orders || []
  };
}

// Aggregate line items with monthly breakdown
function aggregateLineItemsWithSeasonality(recentOrders, seasonalOrders) {
  const map = {}; // variant_id -> { title, totalQty }

  const currentMonth = new Date().getMonth();

  // recent orders → average monthly quantities
  for (const o of recentOrders) {
    for (const li of o.line_items || []) {
      const vid = String(li.variant_id || li.product_id);
      if (!map[vid]) map[vid] = { title: li.name || li.title || "", totalQty: 0 };
      map[vid].totalQty += li.quantity || 0;
    }
  }

  // seasonal orders → only same month as now
  for (const o of seasonalOrders) {
    const month = new Date(o.created_at).getMonth();
    if (month !== currentMonth) continue; // skip other months
    for (const li of o.line_items || []) {
      const vid = String(li.variant_id || li.product_id);
      if (!map[vid]) map[vid] = { title: li.name || li.title || "", totalQty: 0 };
      map[vid].totalQty += li.quantity || 0;
    }
  }

  return map;
}

// Build forecast combining recent + seasonal, take top N
function buildForecast(itemsMap, recentMonths = 6, topN = TOP_ITEMS) {
  const forecast = [];
  for (const [variant_id, data] of Object.entries(itemsMap)) {
    const avgRecentQty = data.totalQty / recentMonths; // approximate recurring
    const totalQty = Math.round(avgRecentQty) > 0 ? Math.round(avgRecentQty) : 1;
    forecast.push({ variant_id, qty: totalQty, title: data.title });
  }

  // sort descending and limit top N
  return forecast.sort((a, b) => b.qty - a.qty).slice(0, topN);
}

// Build Shopify cart URL
function buildCartUrl(items) {
  if (!items || !items.length) return "/cart";
  const parts = items.map(i => `${i.variant_id}:${i.qty}`);
  return `/cart/${parts.join(",")}`;
}

// ---------- ROUTES ----------
app.get("/", (req, res) => res.send("✅ Forecast Assistant running"));

app.post("/forecast", async (req, res) => {
  try {
    const customerId = req.body.customer_id || req.query.customer_id;
    const email = req.body.email || req.query.email;

    if (!customerId && !email) return res.status(400).json({ error: "Provide customer_id or email" });

    const { recentOrders, seasonalOrders } = await fetchCustomerOrders({ customer_id: customerId, email, months: 6, years: 2 });

    if (!recentOrders.length && !seasonalOrders.length) 
      return res.json({ cartUrl: "/cart", message: "No purchases in the last 2 years" });

    const agg = aggregateLineItemsWithSeasonality(recentOrders, seasonalOrders);
    const forecastItems = buildForecast(agg, 6, TOP_ITEMS);

    if (!forecastItems.length) return res.json({ cartUrl: "/cart", message: "No forecastable items found" });

    const cartUrl = buildCartUrl(forecastItems);

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

app.listen(PORT, () => console.log(`✅ Forecast Assistant listening on port ${PORT}`));
