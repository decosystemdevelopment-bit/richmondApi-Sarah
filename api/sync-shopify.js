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
 * 🛒 Shopify
 */
const SHOP = process.env.SHOPIFY_SHOP;

/**
 * 🔑 Get token
 */
async function getAccessToken() {
  const { data, error } = await supabase
    .from("shopify_auth")
    .select("access_token")
    .single();

  if (error || !data?.access_token) {
    throw new Error("❌ No Shopify token");
  }

  return data.access_token;
}

/**
 * ⏱️ Sleep
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 🧠 Status mapping
 */
function mapStatus(status) {
  return status === "archived" ? "draft" : "active";
}

/**
 * 🔍 Fetch variant ID
 */
async function fetchVariantId(productId, headers) {
  const res = await axios.get(
    `https://${SHOP}/admin/api/2026-04/products/${productId}.json`,
    { headers }
  );

  return res.data.product?.variants?.[0]?.id;
}

/**
 * ➕ CREATE
 */
async function createProduct(p, headers) {
  const res = await axios.post(
    `https://${SHOP}/admin/api/2026-04/products.json`,
    {
      product: {
        title: p.title,
        body_html: p.description_fr,
        status: mapStatus(p.status),
        variants: [
          {
            price: String(p.price)
          }
        ]
      }
    },
    { headers }
  );

  return {
    id: res.data.product.id,
    variantId: res.data.product.variants?.[0]?.id
  };
}

/**
 * 🔄 UPDATE
 */
async function updateProduct(p, headers) {
  const productId = p.shopify_product_id;
  let variantId = p.variant_id;

  if (!productId) throw new Error("Missing productId");

  // 🔥 récupérer variant si absent
  if (!variantId) {
    console.log("🔍 Fetch variant...");
    variantId = await fetchVariantId(productId, headers);
    console.log("✅ Variant:", variantId);
  }

  // update product
  await axios.put(
    `https://${SHOP}/admin/api/2026-04/products/${productId}.json`,
    {
      product: {
        id: productId,
        title: p.title,
        body_html: p.description_fr,
        status: mapStatus(p.status)
      }
    },
    { headers }
  );

  // update price
  await axios.put(
    `https://${SHOP}/admin/api/2026-04/variants/${variantId}.json`,
    {
      variant: {
        id: variantId,
        price: String(p.price)
      }
    },
    { headers }
  );

  console.log("💰 Price updated:", p.price);

  return variantId;
}

/**
 * 🔢 Count remaining
 */
async function countRemaining() {
  const { count } = await supabase
    .from("products")
    .select("*", { count: "exact", head: true })
    .eq("needs_shopify_update", true);

  return count || 0;
}

/**
 * 🚀 HANDLER
 */
export default async function handler(req, res) {
  try {
    console.log("🛒 START SHOPIFY SYNC");
    console.log("🏪 SHOP:", SHOP);

    const TOKEN = await getAccessToken();

    const HEADERS = {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json"
    };

    /**
     * 1. FETCH (juste 1 pour debug)
     */
    const { data: products, error } = await supabase
      .from("products")
      .select("*")
      .eq("needs_shopify_update", true)
      .limit(1);

    if (error) throw error;

    if (!products || products.length === 0) {
      return res.status(200).json({
        ok: true,
        message: "Nothing to sync"
      });
    }

    const p = products[0];

    /**
     * 🔥 TEST SHOPIFY (ULTRA IMPORTANT)
     */
    console.log("🧪 TEST PRODUCT ID:", p.shopify_product_id);

    try {
      const test = await axios.get(
        `https://${SHOP}/admin/api/2026-04/products/${p.shopify_product_id}.json`,
        { headers: HEADERS }
      );

      console.log("✅ TEST SUCCESS → Product accessible");

    } catch (err) {
      console.error("❌ TEST FAILED");

      if (err.response) {
        console.error("🔥 SHOPIFY:", err.response.data);
      } else {
        console.error(err.message);
      }

      return res.status(500).json({
        error: "Shopify test failed"
      });
    }

    /**
     * 🔄 SYNC NORMAL (1 produit pour test)
     */
    let shopifyId = p.shopify_product_id;
    let variantId = p.variant_id;

    if (!shopifyId) {
      console.log("➕ CREATE");

      const created = await createProduct(p, HEADERS);
      shopifyId = created.id;
      variantId = created.variantId;

    } else {
      console.log("✏️ UPDATE");

      variantId = await updateProduct(p, HEADERS);
    }

    /**
     * UPDATE DB
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

    console.log("✅ DONE");

    return res.status(200).json({
      ok: true
    });

  } catch (err) {
    console.error("❌ GLOBAL ERROR:", err.message);

    return res.status(500).json({
      error: err.message
    });
  }
}
