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
const TOKEN = process.env.SHOPIFY_TOKEN;

const HEADERS = {
  "X-Shopify-Access-Token": TOKEN,
  "Content-Type": "application/json"
};

/**
 * ⏱️ Rate limit protection
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 🧠 Map status → Shopify
 */
function mapStatus(status) {
  return status === "archived" ? "draft" : "active";
}

/**
 * 🔍 Get first variant ID (IMPORTANT)
 */
async function getVariantId(productId) {
  const res = await axios.get(
    `https://${SHOP}/admin/api/2025-01/products/${productId}.json`,
    { headers: HEADERS }
  );

  return res.data.product.variants?.[0]?.id;
}

/**
 * ➕ CREATE PRODUCT
 */
async function createProduct(p) {
  const res = await axios.post(
    `https://${SHOP}/admin/api/2025-01/products.json`,
    {
      product: {
        title: p.title,
        body_html: p.description_fr,
        status: mapStatus(p.status),
        variants: [
          {
            price: p.price.toString()
          }
        ]
      }
    },
    { headers: HEADERS }
  );

  return {
    id: res.data.product.id,
    variantId: res.data.product.variants?.[0]?.id
  };
}

/**
 * 🔄 UPDATE PRODUCT
 */
async function updateProduct(productId, p) {
  // 1. récupérer le variant ID
  const variantId = await getVariantId(productId);

  // 2. update produit
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

  // 3. update variant (price)
  if (variantId) {
    await axios.put(
      `https://${SHOP}/admin/api/2025-01/variants/${variantId}.json`,
      {
        variant: {
          id: variantId,
          price: p.price.toString()
        }
      },
      { headers: HEADERS }
    );
  }
}

/**
 * 🚀 Handler
 */
export default async function handler(req, res) {
  try {
    console.log("🛒 Shopify sync...");

    /**
     * 1. FETCH produits à sync
     */
    const { data: products, error } = await supabase
      .from("products")
      .select("*")
      .eq("needs_shopify_update", true)
      .limit(50);

    if (error) throw error;

    if (!products || products.length === 0) {
      console.log("✅ Nothing to sync");
      return res.status(200).json({ ok: true, message: "Nothing to sync" });
    }

    /**
     * 2. LOOP
     */
    for (const p of products) {
      try {
        let shopifyId = p.shopify_product_id;

        if (!shopifyId) {
          console.log("➕ Creating:", p.title);

          const created = await createProduct(p);
          shopifyId = created.id;

        } else {
          console.log("🔄 Updating:", p.title);

          await updateProduct(shopifyId, p);
        }

        /**
         * 3. UPDATE DB
         */
        await supabase
          .from("products")
          .update({
            shopify_product_id: shopifyId,
            needs_shopify_update: false,
            last_shopify_sync: new Date().toISOString()
          })
          .eq("id", p.id);

        /**
         * ⏱️ Anti rate-limit
         */
        await sleep(500);

      } catch (err) {
        console.error("❌ Product error:", p.item_code);
        console.error(err.response?.data || err.message);

        // ⚠️ ne pas bloquer toute la boucle
        continue;
      }
    }

    console.log("✅ Shopify sync done");

    return res.status(200).json({
      ok: true,
      processed: products.length
    });

  } catch (err) {
    console.error("❌ Global error:", err.response?.data || err.message);

    return res.status(500).json({
      error: err.message
    });
  }
}
