import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const SHOP = process.env.SHOPIFY_SHOP;
const API_VERSION = "2024-01";

/**
 * 🔑 Token
 */
async function getAccessToken() {
  const { data, error } = await supabase.from("shopify_auth").select("access_token").single();
  if (error || !data?.access_token) throw new Error("❌ No Shopify token");
  return data.access_token;
}

/**
 * 🚀 HANDLER
 */
export default async function handler(req, res) {
  try {
    console.log("🚀 START SYNC (CREATE OR UPDATE)");
    const TOKEN = await getAccessToken();
    const HEADERS = { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" };

    // 1. On prend le premier produit qui a besoin d'une mise à jour
    const { data: products, error } = await supabase
      .from("products")
      .select("*")
      .eq("needs_shopify_update", true)
      .limit(1);

    if (error) throw error;
    if (!products || products.length === 0) {
      return res.status(200).json({ ok: true, message: "Rien à synchroniser." });
    }

    const p = products[0];
    console.log(`📦 Produit cible : ${p.title}`);

    let shopifyId = p.shopify_product_id;
    let variantId = p.variant_id;
    let actionPerfomed = "";

    /**
     * 2. VERIFICATION / DECISION
     */
    let existsOnShopify = false;
    if (shopifyId) {
      try {
        const check = await axios.get(`https://${SHOP}/admin/api/${API_VERSION}/products/${shopifyId}.json`, { headers: HEADERS });
        existsOnShopify = true;
        variantId = check.data.product.variants[0].id;
        console.log("🔍 Produit trouvé sur Shopify -> Mode UPDATE");
      } catch (err) {
        if (err.response?.status === 404) {
          console.log("⚠️ ID invalide/inexistant sur Shopify -> Mode CREATE");
          existsOnShopify = false;
        } else {
          throw err;
        }
      }
    }

    /**
     * 3. EXECUTION (CREATE ou UPDATE)
     */
    if (!existsOnShopify) {
      // --- MODE CREATE ---
      const createRes = await axios.post(
        `https://${SHOP}/admin/api/${API_VERSION}/products.json`,
        {
          product: {
            title: p.title,
            body_html: p.description_fr || "",
            vendor: "Richmond",
            status: p.status === "archived" ? "draft" : "active",
            variants: [{ price: String(p.price), sku: p.item_code || "" }]
          }
        },
        { headers: HEADERS }
      );
      shopifyId = createRes.data.product.id;
      variantId = createRes.data.product.variants[0].id;
      actionPerfomed = "CREATED";
    } else {
      // --- MODE UPDATE ---
      await axios.put(
        `https://${SHOP}/admin/api/${API_VERSION}/products/${shopifyId}.json`,
        {
          product: {
            id: shopifyId,
            title: p.title,
            body_html: p.description_fr || "",
            status: p.status === "archived" ? "draft" : "active"
          }
        },
        { headers: HEADERS }
      );

      await axios.put(
        `https://${SHOP}/admin/api/${API_VERSION}/variants/${variantId}.json`,
        {
          variant: { id: variantId, price: String(p.price) }
        },
        { headers: HEADERS }
      );
      actionPerfomed = "UPDATED";
    }

    /**
     * 4. UPDATE SUPABASE
     */
    await supabase
      .from("products")
      .update({
        shopify_product_id: String(shopifyId),
        variant_id: String(variantId),
        needs_shopify_update: false,
        last_shopify_sync: new Date().toISOString()
      })
      .eq("id", p.id);

    console.log(`✅ SUCCESS: Produit ${actionPerfomed}`);

    return res.status(200).json({
      ok: true,
      action: actionPerfomed,
      title: p.title,
      id: shopifyId
    });

  } catch (err) {
    console.error("❌ ERREUR :");
    console.error(err.response?.data || err.message);
    return res.status(500).json({ error: err.message, details: err.response?.data });
  }
}
