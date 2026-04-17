/**
 * ============================================================
 *  Supabase → Shopify Sync
 * ============================================================
 *
 * Objectif :
 * Synchroniser les produits depuis Supabase vers Shopify,
 * uniquement lorsque des modifications ont été détectées
 * côté Richmond (via le flag `needs_shopify_update`).
 *
 * ------------------------------------------------------------
 * Fonctionnement global :
 *
 * 1. Récupère les produits dans Supabase avec :
 *    → needs_shopify_update = true
 *
 * 2. Pour chaque produit :
 *    - Si `shopify_product_id` existe :
 *        → UPDATE du produit sur Shopify
 *
 *    - Sinon :
 *        → CREATE du produit sur Shopify
 *
 * 3. Une fois synchronisé :
 *    - met à jour `shopify_product_id` (si création)
 *    - met `needs_shopify_update = false`
 *    - enregistre `last_shopify_sync`
 *
 * ------------------------------------------------------------
 * Batch processing :
 * Limité à 50 produits par exécution pour :
 *    - éviter les rate limits Shopify
 *    - éviter les timeouts Vercel
 *
 * ------------------------------------------------------------
 * Champs clés :
 *
 * - needs_shopify_update :
 *   Flag déclenché par le script Richmond
 *   → indique qu'un produit doit être synchronisé
 *
 * - shopify_product_id :
 *   ID du produit côté Shopify
 *   → permet de savoir si on fait un UPDATE ou CREATE
 *
 * - last_shopify_sync :
 *   Date de la dernière synchronisation Shopify
 *
 * ------------------------------------------------------------
 * Limitations actuelles :
 *
 * - Ne gère que :
 *    → title
 *    → description (body_html)
 *    → price
 *
 * - Ne gère pas encore :
 *    → stock (inventory)
 *    → images
 *    → metafields
 *    → variants avancés
 *
 * ------------------------------------------------------------
 * Résultat :
 *
 * Ce script agit comme un "worker Shopify"
 * qui applique uniquement les changements détectés
 * par le sync Richmond.
 *
 * Supabase agit comme source de vérité intermédiaire.
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

// 🆕 CREATE
async function createProduct(p) {
  const res = await axios.post(
    `https://${SHOP}/admin/api/2025-01/products.json`,
    {
      product: {
        title: p.title,
        body_html: p.description_fr,
        variants: [
          {
            price: p.price.toString()
          }
        ]
      }
    },
    { headers: HEADERS }
  );

  return res.data.product.id;
}

// 🔄 UPDATE
async function updateProduct(id, p) {
  await axios.put(
    `https://${SHOP}/admin/api/2025-01/products/${id}.json`,
    {
      product: {
        id,
        title: p.title,
        body_html: p.description_fr,
        variants: [
          {
            price: p.price.toString()
          }
        ]
      }
    },
    { headers: HEADERS }
  );
}

export default async function handler(req, res) {
  try {
    console.log("🛍️ Shopify sync...");

    const { data: products } = await supabase
      .from("products")
      .select("*")
      .eq("needs_shopify_update", true)
      .limit(50);

    for (const p of products) {
      let id = p.shopify_product_id;

      if (!id) {
        id = await createProduct(p);
      } else {
        await updateProduct(id, p);
      }

      await supabase
        .from("products")
        .update({
          shopify_product_id: id,
          needs_shopify_update: false,
          last_shopify_sync: new Date().toISOString()
        })
        .eq("id", p.id);
    }

    console.log("✅ Shopify sync done");
    res.status(200).json({ ok: true });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
}
