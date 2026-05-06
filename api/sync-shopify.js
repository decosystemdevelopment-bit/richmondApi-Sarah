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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function mapStatus(status) {
  return status === "archived" ? "draft" : "active";
}

async function countRemaining() {
  const { count } = await supabase
    .from("products")
    .select("*", { count: "exact", head: true })
    .eq("needs_shopify_update", true);

  return count || 0;
}

/**
 * CREATE
 */
async function createProduct(p) {
  console.log("➡️ CREATE PAYLOAD:", {
    title: p.title,
    price: p.price
  });

  const res = await axios.post(
    `https://${SHOP}/admin/api/2025-01/products.json`,
    {
      product: {
        title: p.title,
        body_html: p.description_fr,
        status: mapStatus(p.status),
        variants: [
          {
            price: p.price?.toString()
          }
        ]
      }
    },
    { headers: HEADERS }
  );

  console.log("✅ CREATED:", res.data.product.id);

  return {
    id: res.data.product.id,
    variantId: res.data.product.variants?.[0]?.id
  };
}

/**
 * UPDATE
 */
async function updateProduct(p) {
  console.log("➡️ UPDATE PRODUCT:", p.item_code);

  const productId = p.shopify_product_id;
  const variantId = p.variant_id;

  if (!productId) {
    throw new Error("Missing shopify_product_id");
  }

  await axios.put(
    `https://${SHOP}/admin/api/2025-01/products/${productId}.json`,
    {
      product: {
        id: productId,
        title: p.title,
        body_html: p.description_fr,
        status: mapStatus(p.status)
      }
    },
    { headers: HEADERS }
  );

  console.log("✅ PRODUCT UPDATED:", productId);

  if (!variantId) {
    console.warn("⚠️ NO VARIANT ID → PRICE SKIPPED", p.item_code);
    return;
  }

  await axios.put(
    `https://${SHOP}/admin/api/2025-01/variants/${variantId}.json`,
    {
      variant: {
        id: variantId,
        price: p.price?.toString()
      }
    },
    { headers: HEADERS }
  );

  console.log("💰 PRICE UPDATED:", p.price);
}

/**
 * HANDLER
 */
export default async function handler(req, res) {
  try {
    console.log("🛒 START SHOPIFY SYNC");

    const { data: products, error } = await supabase
      .from("products")
      .select("*")
      .eq("needs_shopify_update", true)
      .order("created_at", { ascending: true }) // 🔥 important
      .limit(50);

    if (error) {
      console.error("❌ SUPABASE FETCH ERROR:", error);
      throw error;
    }

    console.log(`📦 FETCHED: ${products?.length || 0}`);

    if (!products || products.length === 0) {
      return res.status(200).json({
        ok: true,
        message: "Nothing to sync"
      });
    }

    let processed = 0;

    for (const p of products) {
      console.log("=================================");
      console.log("🔍 PRODUCT:", p.item_code);
      console.log("➡️ DATA:", {
        shopify_id: p.shopify_product_id,
        variant_id: p.variant_id,
        price: p.price
      });

      try {
        if (!p.price || isNaN(p.price)) {
          console.warn("⚠️ INVALID PRICE → SKIP", p.item_code);
          continue;
        }

        let shopifyId = p.shopify_product_id;
        let variantId = p.variant_id;

        if (!shopifyId) {
          console.log("➕ CREATING PRODUCT");

          const created = await createProduct(p);

          shopifyId = created.id;
          variantId = created.variantId;

        } else {
          console.log("🔄 UPDATING PRODUCT");

          await updateProduct(p);
        }

        const { error: updateError } = await supabase
          .from("products")
          .update({
            shopify_product_id: shopifyId,
            variant_id: variantId,
            needs_shopify_update: false,
            last_shopify_sync: new Date().toISOString()
          })
          .eq("id", p.id);

        if (updateError) {
          console.error("❌ SUPABASE UPDATE ERROR:", updateError);
        } else {
          console.log("✅ DB UPDATED");
        }

        processed++;

        await sleep(600);

      } catch (err) {
        console.error("❌ PRODUCT ERROR:", p.item_code);

        if (err.response) {
          console.error("🔥 SHOPIFY ERROR:");
          console.error(JSON.stringify(err.response.data, null, 2));
        } else {
          console.error("🔥 ERROR:", err.message);
        }

        continue;
      }
    }

    const remaining = await countRemaining();

    console.log("=================================");
    console.log(`✅ DONE: ${processed}`);
    console.log(`📊 REMAINING: ${remaining}`);

    return res.status(200).json({
      ok: true,
      processed,
      remaining
    });

  } catch (err) {
    console.error("❌ GLOBAL ERROR:", err.message);

    return res.status(500).json({
      error: err.message
    });
  }
}
