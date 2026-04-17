/**
 * SCRIPT UTILITAIRE (NE PAS UTILISER EN PROD AUTOMATIQUE)
 *
 * Objectif :
 * Associer les produits Shopify aux produits Supabase
 * via le SKU (item_code).
 *
 * Usage :
 * - migration initiale
 * - récupération des shopify_product_id
 * - debug ponctuel
 *
 * Ne doit PAS être exécuté en routine :
 * - risque d’écraser des données correctes
 * - dépend fortement de la qualité des SKU Shopify
 *
 * Hypothèse :
 * - 1 produit = 1 variant
 * - SKU = item_code
 *
 * ============================================================
 */

import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_TOKEN;

const HEADERS = {
  "X-Shopify-Access-Token": TOKEN,
  "Content-Type": "application/json"
};

export default async function handler(req, res) {
  try {
    console.log("🔗 Linking Shopify products...");

    const response = await axios.get(
      `https://${SHOP}/admin/api/2025-01/products.json?limit=250`,
      { headers: HEADERS }
    );

    const products = response.data.products;

    for (const product of products) {
      const variant = product.variants[0];
      const sku = variant?.sku;

      if (!sku) continue;

      await supabase
        .from("products")
        .update({
          shopify_product_id: product.id
        })
        .eq("item_code", sku);
    }

    console.log("✅ Linking done");
    res.status(200).json({ ok: true });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
}
