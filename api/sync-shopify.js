import axios from "axios";
import { createClient } from "@supabase/supabase-js";

/**
 * 🔌 Configuration Clients
 */
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const SHOP = process.env.SHOPIFY_SHOP;
const API_VERSION = "2024-01"; // Version stable recommandée

/**
 * 🔑 Récupération du Token Shopify depuis Supabase
 */
async function getAccessToken() {
  const { data, error } = await supabase
    .from("shopify_auth")
    .select("access_token")
    .single();

  if (error || !data?.access_token) throw new Error("❌ No Shopify token in DB");
  return data.access_token;
}

/**
 * 🔍 Récupérer l'ID du premier variant d'un produit Shopify
 */
async function fetchVariantId(productId, headers) {
  try {
    const res = await axios.get(
      `https://${SHOP}/admin/api/${API_VERSION}/products/${productId}.json`,
      { headers }
    );
    return res.data.product?.variants?.[0]?.id;
  } catch (error) {
    console.error(`❌ Error fetching variant for product ${productId}`);
    return null;
  }
}

/**
 * 🔄 UPDATE : Mise à jour Titre, Description, Statut et Prix
 */
async function updateProduct(p, headers) {
  const productId = p.shopify_product_id;
  let variantId = p.variant_id;

  // Si on n'a pas le variant_id en DB, on va le chercher chez Shopify
  if (!variantId) {
    console.log(`🔍 Variant ID manquant pour ${productId}, récupération...`);
    variantId = await fetchVariantId(productId, headers);
  }

  if (!variantId) throw new Error(`Impossible de trouver un variant pour le produit ${productId}`);

  // 1. Update du produit (Titre, Body, Status)
  await axios.put(
    `https://${SHOP}/admin/api/${API_VERSION}/products/${productId}.json`,
    {
      product: {
        id: productId,
        title: p.title,
        body_html: p.description_fr,
        status: p.status === "archived" ? "draft" : "active"
      }
    },
    { headers }
  );

  // 2. Update du prix sur le variant
  await axios.put(
    `https://${SHOP}/admin/api/${API_VERSION}/variants/${variantId}.json`,
    {
      variant: {
        id: variantId,
        price: String(p.price)
      }
    },
    { headers }
  );

  return variantId;
}

/**
 * 🚀 HANDLER PRINCIPAL (Vercel)
 */
export default async function handler(req, res) {
  try {
    console.log("---------------------------------------");
    console.log("🛒 START SHOPIFY SYNC (TEST MODE)");
    
    const TOKEN = await getAccessToken();
    const HEADERS = {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json"
    };

    /**
     * 1. FETCH PRODUIT
     * On filtre explicitement pour ignorer les ID null (ton souhait pour le test)
     */
    const { data: products, error } = await supabase
      .from("products")
      .select("*")
      .eq("needs_shopify_update", true)
      .not("shopify_product_id", "is", null) // 🔥 On ignore les "null"
      .limit(1);

    if (error) throw error;

    if (!products || products.length === 0) {
      console.log("ℹ️ Aucun produit avec shopify_product_id trouvé pour la sync.");
      return res.status(200).json({ ok: true, message: "Nothing to sync (filtered)" });
    }

    const p = products[0];
    console.log(`📦 Processing Product: ${p.title} (ID: ${p.shopify_product_id})`);

    /**
     * 2. TEST DE CONNEXION (Optionnel mais sécurisé)
     */
    try {
      await axios.get(
        `https://${SHOP}/admin/api/${API_VERSION}/products/${p.shopify_product_id}.json`,
        { headers: HEADERS }
      );
      console.log("✅ Shopify API: Connection OK");
    } catch (err) {
      console.error("❌ Shopify API: Product ID not found on store.");
      return res.status(404).json({ error: "Product ID exists in DB but not in Shopify" });
    }

    /**
     * 3. EXECUTION DE L'UPDATE
     */
    console.log("✏️ Updating Shopify...");
    const finalVariantId = await updateProduct(p, HEADERS);

    /**
     * 4. MISE À JOUR SUPABASE
     */
    await supabase
      .from("products")
      .update({
        variant_id: finalVariantId,
        needs_shopify_update: false,
        last_shopify_sync: new Date().toISOString()
      })
      .eq("id", p.id);

    console.log("✅ SYNC SUCCESSFUL");
    console.log("---------------------------------------");

    return res.status(200).json({
      success: true,
      product: p.title,
      shopify_id: p.shopify_product_id
    });

  } catch (err) {
    console.error("❌ GLOBAL ERROR:", err.response?.data || err.message);
    return res.status(500).json({
      error: err.message,
      details: err.response?.data || "No details"
    });
  }
}
