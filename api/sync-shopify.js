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
 * 🔑 Récupère le token dynamiquement
 */
async function getAccessToken() {
  const { data, error } = await supabase
    .from("shopify_auth")
    .select("access_token")
    .single();

  if (error || !data?.access_token) {
    throw new Error("❌ Shopify token introuvable");
  }

  return data.access_token;
}

/**
 * ⏱️ Sleep (anti rate limit)
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
 * 🔍 Récupère variant ID depuis Shopify
 */
async function fetchVariantId(productId, headers) {
  const res = await axios.get(
    `https://${SHOP}/admin/api/2025-01/products/${productId}.json`,
    { headers }
  );

  return res.data.product?.variants?.[0]?.id;
}

/**
 * ➕ CREATE PRODUCT
 */
async function createProduct(p, headers) {
  const res = await axios.post(
    `https://${SHOP}/admin/api/2025-01/products.json`,
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

  const product = res.data.product;

  return {
    id: product.id,
    variantId: product.variants?.[0]?.id
  };
}

/**
 * 🔄 UPDATE PRODUCT + PRICE
 */
async function updateProduct(p, headers) {
  const productId = p.shopify_product_id;
  let variantId = p.variant_id;

  if (!productId) throw new Error("Missing productId");

  // 🔥 récupérer variant si absent
  if (!variantId) {
    console.log("🔍 Fetching variant ID...");
    variantId = await fetchVariantId(productId, headers);
    console.log("✅ Variant found:", variantId);
  }

  // update product
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
    { headers }
  );

  // update price
  if (variantId) {
    await axios.put(
      `https://${SHOP}/admin/api/2025-01/variants/${variantId}.json`,
      {
        variant: {
          id: variantId,
          price: String(p.price)
        }
      },
      { headers }
    );

    console.log("💰 Price updated:", p.price);
  } else {
    throw new Error("Variant introuvable");
  }

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

    const TOKEN = await getAccessToken();

    const HEADERS = {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json"
    };

    /**
     * 1. FETCH
     */
    const { data: products, error } = await supabase
      .from("products")
      .select("*")
      .eq("needs_shopify_update", true)
      .order("created_at", { ascending: true })
      .limit(50);

    if (error) throw error;

    if (!products || products.length === 0) {
      return res.status(200).json({
        ok: true,
        message: "Nothing to sync",
        remaining: 0
      });
    }

    let processed = 0;

    /**
     * 2. LOOP
     */
    for (const p of products) {
      try {
        console.log("🔄 Product:", p.item_code);

        if (!p.price || isNaN(p.price)) {
          console.warn("⚠️ Invalid price → skip");
          continue;
        }

        let shopifyId = p.shopify_product_id;
        let variantId = p.variant_id;

        // CREATE
        if (!shopifyId) {
          console.log("➕ Creating product");

          const created = await createProduct(p, HEADERS);

          shopifyId = created.id;
          variantId = created.variantId;

        } else {
          console.log("✏️ Updating product");

          variantId = await updateProduct(p, HEADERS);
        }

        /**
         * UPDATE SUPABASE
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
        console.error("❌ ERROR PRODUCT:", p.item_code);

        if (err.response) {
          console.error(err.response.data);
        } else {
          console.error(err.message);
        }

        continue;
      }
    }

    const remaining = await countRemaining();

    console.log(`✅ DONE: ${processed} | Remaining: ${remaining}`);

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
