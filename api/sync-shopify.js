import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const SHOP = process.env.SHOPIFY_SHOP;
const API_VERSION = "2024-01";

async function getAccessToken() {
  const { data, error } = await supabase.from("shopify_auth").select("access_token").single();
  if (error || !data?.access_token) throw new Error("❌ No Shopify token");
  return data.access_token;
}

export default async function handler(req, res) {
  try {
    console.log("🚀 TEST SYNC : Applique murale Oravelle");
    const TOKEN = await getAccessToken();
    const HEADERS = { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" };

    // 1. Sélection spécifique du produit Oravelle
    const { data: p, error } = await supabase
      .from("products")
      .select("*")
      .eq("id", "00136d52-fc0e-48f8-b50b-769f5c10fe3f") 
      .single();

    if (error || !p) throw new Error("Produit Oravelle non trouvé dans Supabase");

    console.log(`📦 Données lues : ${p.title} (SKU: ${p.item_code})`);

    // --- PRÉPARATION DES MÉTAFIELDS ---
    const metafields = [
      { namespace: "custom", key: "volume", value: String(p.volume || 0), type: "number_decimal" },
      { namespace: "custom", key: "weight", value: String(p.weight || 0), type: "number_decimal" },
      { namespace: "custom", key: "depth", value: String(p.depth || 0), type: "number_decimal" },
      { namespace: "custom", key: "height", value: String(p.height || 0), type: "number_decimal" },
      { namespace: "custom", key: "width", value: String(p.width || 0), type: "number_decimal" },
      { namespace: "custom", key: "color_richmond", value: p.color || "white", type: "single_line_text_field" },
      // Pour les matériaux, on transforme "Iron|Mirror|Resin" en tableau JSON
      { 
        namespace: "custom", 
        key: "materials_richmond", 
        value: JSON.stringify(p.materials ? p.materials.split('|') : []), 
        type: "json" 
      }
    ];

    // --- PRÉPARATION DU PAYLOAD ---
    const productPayload = {
      title: p.title,
      body_html: p.description_fr || "",
      vendor: "Richmond Interiors",
      status: p.status === "active" ? "active" : "draft",
      images: (p.images || []).map(url => ({ src: url })),
      metafields: metafields,
      variants: [{
        sku: p.item_code,
        price: String(p.price),
        barcode: p.ean || "",
        inventory_management: "shopify",
        inventory_policy: "deny"
      }]
    };

    let shopifyId = p.shopify_product_id;
    let variantId = p.variant_id;
    let exists = false;

    // 2. VÉRIFICATION SUR SHOPIFY
    if (shopifyId) {
      try {
        const check = await axios.get(`https://${SHOP}/admin/api/${API_VERSION}/products/${shopifyId}.json`, { headers: HEADERS });
        exists = true;
        variantId = check.data.product.variants[0].id;
        console.log("🔄 Produit déjà présent sur Shopify. Mode Mise à jour.");
      } catch (e) {
        console.log("⚠️ ID Shopify obsolète. Bascule en mode Création.");
        exists = false;
      }
    }

    // 3. EXECUTION
    if (!exists) {
      console.log("➕ Création sur Shopify...");
      const res = await axios.post(`https://${SHOP}/admin/api/${API_VERSION}/products.json`, { product: productPayload }, { headers: HEADERS });
      shopifyId = res.data.product.id;
      variantId = res.data.product.variants[0].id;
    } else {
      console.log("✏️ Mise à jour sur Shopify...");
      await axios.put(`https://${SHOP}/admin/api/${API_VERSION}/products/${shopifyId}.json`, { product: { id: shopifyId, ...productPayload } }, { headers: HEADERS });
    }

    // 4. SYNCHRONISATION DU STOCK (20 unités selon tes données)
    if (variantId && p.stock_quantity !== null) {
      try {
        const locRes = await axios.get(`https://${SHOP}/admin/api/${API_VERSION}/locations.json`, { headers: HEADERS });
        const locationId = locRes.data.locations[0].id;

        const varRes = await axios.get(`https://${SHOP}/admin/api/${API_VERSION}/variants/${variantId}.json`, { headers: HEADERS });
        const inventoryItemId = varRes.data.variant.inventory_item_id;

        await axios.post(`https://${SHOP}/admin/api/${API_VERSION}/inventory_levels/set.json`, {
          location_id: locationId,
          inventory_item_id: inventoryItemId,
          available: parseInt(p.stock_quantity)
        }, { headers: HEADERS });
        console.log(`🔢 Stock synchronisé : ${p.stock_quantity} unités`);
      } catch (sErr) {
        console.error("⚠️ Erreur Stock:", sErr.response?.data || sErr.message);
      }
    }

    // 5. MISE À JOUR BASE DE DONNÉES
    await supabase.from("products").update({
      shopify_product_id: String(shopifyId),
      variant_id: String(variantId),
      needs_shopify_update: false,
      last_shopify_sync: new Date().toISOString()
    }).eq("id", p.id);

    console.log("✅ TEST RÉUSSI : Oravelle est à jour.");
    
    return res.status(200).json({ 
      ok: true, 
      action: exists ? "updated" : "created",
      shopify_url: `https://${SHOP}/admin/products/${shopifyId}` 
    });

  } catch (err) {
    console.error("❌ ERREUR :");
    console.error(err.response?.data || err.message);
    return res.status(500).json({ error: err.message, details: err.response?.data });
  }
}
