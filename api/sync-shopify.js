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

/**
 * 🔌 Supabase
 */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

/**
 * 🛒 Shopify config
 */
const SHOP = process.env.SHOPIFY_SHOP;

/**
 * ⏱️ Sleep (rate limit)
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 🧠 Map status
 */
function mapStatus(status) {
  return status === "archived" ? "draft" : "active";
}

/**
 * 🔑 Get Shopify token (SAFE)
 */
async function getAccessToken() {
  const { data, error } = await supabase
    .from("shopify_auth")
    .select("access_token")
    .single();

  if (error) {
    console.error("❌ TOKEN FETCH ERROR:", error);
    return null;
  }

  return data?.access_token;
}

/**
 * 📊 Count remaining
 */
async function countRemaining() {
  const { count } = await supabase
    .from("products")
    .select("*", { count: "exact", head: true })
    .eq("needs_shopify_update", true);

  return count || 0;
}

/**
 * ➕ CREATE PRODUCT
 */
async function createProduct(p, HEADERS) {
  console.log("➕ CREATE:", p.item_code);

  const res = await axios.post(
    `https://${SHOP}/admin/api/2025-01/products.json`,
    {
      product: {
        title: p.title || "Untitled",
        body_html: p.description_fr || "",
        status: mapStatus(p.status),
        variants: [
          {
            price: String(p.price)
          }
        ]
      }
    },
    { headers: HEADERS }
  );

  const product = res.data.product;

  console.log("✅ CREATED:", product.id);

  return {
    id: product.id,
    variantId: product.variants?.[0]?.id
  };
}

/**
 * 🔄 UPDATE PRODUCT
 */
async function updateProduct(p, HEADERS) {
  console.log("🔄 UPDATE:", p.item_code);

  const productId = p.shopify_product_id;
  const variantId = p.variant_id;

  if (!productId) throw new Error("Missing productId");

  // Update product
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

  // Update price
  if (variantId) {
    await axios.put(
      `https://${SHOP}/admin/api/2025-01/variants/${variantId}.json`,
      {
        variant: {
          id: variantId,
          price: String(p.price)
        }
      },
      { headers: HEADERS }
    );

    console.log("💰 PRICE UPDATED:", p.price);
  } else {
    console.warn("⚠️ Missing variant_id:", p.item_code);
  }
}

/**
 * 🚀 HANDLER
 */
export default async function handler(req, res) {
  try {
    console.log("🛒 START SHOPIFY SYNC");

    /**
     * 🔑 TOKEN (CRITICAL FIX)
     */
    const TOKEN = await getAccessToken();

    console.log("🔥 TOKEN:", TOKEN);

    if (!TOKEN) {
      return res.status(500).json({
        error: "No Shopify token"
      });
    }

    const HEADERS = {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json"
    };

    /**
     * 📦 FETCH PRODUCTS
     */
    const { data: products, error } = await supabase
      .from("products")
      .select("*")
      .eq("needs_shopify_update", true)
      .order("created_at", { ascending: true })
      .limit(50);

    if (error) throw error;

    console.log(`📦 FETCHED: ${products?.length || 0}`);

    if (!products || products.length === 0) {
      return res.status(200).json({
        ok: true,
        processed: 0,
        remaining: await countRemaining()
      });
    }

    let processed = 0;

    /**
     * 🔁 LOOP
     */
    for (const p of products) {
      try {
        console.log("=================================");
        console.log("🔍 PRODUCT:", p.item_code);

        if (!p.price || isNaN(p.price)) {
          console.warn("⚠️ INVALID PRICE:", p.item_code);
          continue;
        }

        let shopifyId = p.shopify_product_id;
        let variantId = p.variant_id;

        if (!shopifyId) {
          const created = await createProduct(p, HEADERS);
          shopifyId = created.id;
          variantId = created.variantId;
        } else {
          await updateProduct(p, HEADERS);
        }

        /**
         * 💾 UPDATE DB
         */
        await supabase
          .from("products")
          .update({
            shopify_product_id: shopifyId,
            variant_id: variantId,
            needs_shopify_update: false,
            last_shopify_sync: new Date().toISOString()
          })
          .eq("id", p.id);

        processed++;

        await sleep(500);

      } catch (err) {
        console.error("❌ PRODUCT ERROR:", p.item_code);

        if (err.response) {
          console.error("🔥 SHOPIFY:", err.response.data);
        } else {
          console.error(err.message);
        }

        continue;
      }
    }

    /**
     * 📊 FINAL
     */
    const remaining = await countRemaining();

    console.log(`✅ DONE: ${processed}`);
    console.log(`📊 REMAINING: ${remaining}`);

    return res.status(200).json({
      ok: true,
      processed,
      remaining
    });

  } catch (err) {
    console.error("❌ GLOBAL ERROR:", err);

    return res.status(500).json({
      error: err.message
    });
  }
}
