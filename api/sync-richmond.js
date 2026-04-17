import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const BASE = "https://www.richmondinteriors.nl/api/v1/products";
const AUTH = process.env.RICHMOND_AUTH;

const API = {
  details: `${BASE}/details/${AUTH}`,
  pricing: `${BASE}/pricing/${AUTH}`,
  stock: `${BASE}/stocklevels/${AUTH}`,
  desc: `${BASE}/descriptions/${AUTH}`
};

// 🧠 HASH
function generateHash(data) {
  return crypto
    .createHash("md5")
    .update(JSON.stringify(data))
    .digest("hex");
}

export default async function handler(req, res) {
  try {
    console.log("🔄 Richmond sync...");

    const [productsRes, pricingRes, stockRes, descRes] =
      await Promise.all([
        axios.get(API.details),
        axios.get(API.pricing),
        axios.get(API.stock),
        axios.get(API.desc)
      ]);

    const pricingMap = Object.fromEntries(
      pricingRes.data.map(p => [p.itemCodeNew, p])
    );

    const stockMap = Object.fromEntries(
      stockRes.data.map(s => [s.itemCodeNew, s])
    );

    const descMap = Object.fromEntries(
      descRes.data.map(d => [d.itemCodeNew, d])
    );

    //const products = productsRes.data.slice(0, 20);
    const BATCH_SIZE = 100;
    const products = productsRes.data.slice(0, BATCH_SIZE);
    
    for (const p of products) {
      const code = p.itemCodeNew;

      const priceData = pricingMap[code];
      const stockData = stockMap[code];
      const desc = descMap[code];

      const productData = {
        title: p.description2 || p.description3,
        price: parseFloat(priceData?.retailPrice?.replace(",", ".")) || 0,
        stock: parseInt(stockData?.StockIndicator) || 0,
        description: desc?.longDescriptionFR || "",
        images: p["Product Images"] || ""
      };

      const hash = generateHash(productData);

      const { data: existing } = await supabase
        .from("products")
        .select("richmond_hash")
        .eq("item_code", code)
        .single();

      const hasChanged = existing?.richmond_hash !== hash;

      await supabase.from("products").upsert({
        item_code: code,
        title: productData.title,
        price: productData.price,
        stock_quantity: productData.stock,
        description_fr: productData.description,
        images: productData.images,

        richmond_hash: hash,
        needs_shopify_update: hasChanged,
        last_richmond_sync: new Date().toISOString()
      }, {
        onConflict: "item_code"
      });
    }

    console.log("✅ Richmond sync done");
    res.status(200).json({ ok: true });

  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
}
