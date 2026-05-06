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
    console.log("🚀 TEST SYNC PRODUIT SPÉCIFIQUE");
    const TOKEN = await getAccessToken();
    const HEADERS = { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" };

    /**
     * 1. SÉLECTION DU PRODUIT DE TEST
     * Remplace 'TON_ID_UUID' par l'id réel (ex: f8f351d8-2b69-45dc-965d-973cdd88e2ce)
     */
    const { data: products, error } = await supabase
      .from("products")
      .select("*")
      .eq("id", "00136d52-fc0e-48f8-b50b-769f5c10fe3f") // Mets l'ID du produit que tu veux tester
      .single();

    if (error || !products) throw new Error("Produit non trouvé dans Supabase");

    const p = products;
    console.log(`📦 Test sur : ${p.title} (SKU: ${p.item_code})`);

    // --- PRÉPARATION DES DONNÉES ---
    
    // Metafields
    const metafields = [
      { namespace: "custom", key: "volume", value: String(p.volume || 0), type: "number_decimal" },
      { namespace: "custom", key: "weight", value: String(p.weight || 0), type: "number_decimal" },
      { namespace: "custom", key: "depth", value: String(p.depth || 0), type: "number_decimal" },
      { namespace: "custom", key: "height", value: String(p.height || 0), type: "number_decimal" },
      { namespace: "custom", key: "width", value: String(p.width || 0), type: "number_decimal" },
      { namespace: "custom", key: "color_richmond", value: p.color || "N/A", type: "single_line_text_field" },
      { namespace: "custom", key: "materials_richmond", value: JSON.stringify(p.materials ? [p.materials] : []), type: "json" }
    ];

    // Images
    const shopifyImages = (p.images || []).map(url => ({ src: url }));

    // Payload Produit
    const productPayload = {
      title: p.title,
      body_html: p.description_fr || "",
      vendor: "Richmond Interiors",
      status: p.status === "archived" ? "draft" : "active",
      images: shopifyImages,
      metafields: metafields,
      variants: [{
        sku: p.item_code,
        price: String(p.price),
        inventory_management: "shopify",
        inventory_policy: "deny"
      }]
    };

    let shopifyId = p.shopify_product_id;
    let variantId = p.variant_id;

    // 2. LOGIQUE CREATE / UPDATE
    let exists = false;
    if (shopifyId) {
      try {
        const check = await axios.get(`https://${SHOP}/admin/api/${API_VERSION}/products/${shopifyId}.json`, { headers: HEADERS });
        exists = true;
        variantId = check.data.product.variants[0].id;
        console.log("🔄 Update mode");
      } catch (e) {
        console.log("⚠️ ID présent mais introuvable sur Shopify, bascule en mode Création.");
        exists = false;
      }
    }

    if (!exists) {
      console.log("➕ Création...");
      const res = await axios.post(`https://${SHOP}/admin/api/${API_VERSION}/products.json`, { product: productPayload }, { headers: HEADERS });
      shopifyId = res.data.product.id;
      variantId = res.data.product.variants[0].id;
    } else {
      console.log("✏️ Mise à jour...");
      await axios.put(`https://${SHOP}/admin/api/${API_VERSION}/products/${shopifyId}.json`, { product: { id: shopifyId, ...productPayload } }, { headers: HEADERS });
    }

    // 3. SYNC STOCK
    if (variantId && p.stock_quantity !== null) {
      const locRes = await axios.get(`https://${SHOP}/admin/api/${API_VERSION}/locations.json`, { headers: HEADERS });
      const locationId = locRes.data.locations[0].id;
      const varRes = await axios.get(`https://${SHOP}/admin/api/${API_VERSION}/variants/${variantId}.json`, { headers: HEADERS });
      const inventoryItemId = varRes.data.variant.inventory_item_id;

      await axios.post(`https://${SHOP}/admin/api/${API_VERSION}/inventory_levels/set.json`, {
        location_id: locationId,
        inventory_item_id: inventoryItemId,
        available: p.stock_quantity
      }, { headers: HEADERS });
      console.log(`🔢 Stock réglé à : ${p.stock_quantity}`);
    }

    // 4. MAJ SUPABASE
    await supabase.from("products").update({
      shopify_product_id: String(shopifyId),
      variant_id: String(variantId),
      needs_shopify_update: false,
      last_shopify_sync: new Date().toISOString()
    }).eq("id", p.id);

    console.log("✅ TEST RÉUSSI");
    return res.status(200).json({ ok: true, message: `Produit ${p.item_code} synchronisé.` });

  } catch (err) {
    console.error("❌ ERREUR :");
    console.error(err.response?.data || err.message);
    return res.status(500).json({ error: err.message, details: err.response?.data });
  }
}

/*import axios from "axios";
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
    console.log("🚀 START FULL SYNC + METAFIELDS");
    const TOKEN = await getAccessToken();
    const HEADERS = { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" };

    const { data: products, error } = await supabase
      .from("products")
      .select("*")
      .eq("needs_shopify_update", true)
      .limit(1);

    if (error) throw error;
    if (!products || products.length === 0) return res.status(200).json({ ok: true, message: "Rien à sync." });

    const p = products[0];
    console.log(`📦 Produit : ${p.title} (${p.item_code})`);

    // 1. Préparation des Metafields
    const metafields = [
      { namespace: "custom", key: "volume", value: String(p.volume || 0), type: "number_decimal" },
      { namespace: "custom", key: "weight", value: String(p.weight || 0), type: "number_decimal" },
      { namespace: "custom", key: "depth", value: String(p.depth || 0), type: "number_decimal" },
      { namespace: "custom", key: "height", value: String(p.height || 0), type: "number_decimal" },
      { namespace: "custom", key: "width", value: String(p.width || 0), type: "number_decimal" },
      { namespace: "custom", key: "color_richmond", value: p.color || "N/A", type: "single_line_text_field" },
      { namespace: "custom", key: "materials_richmond", value: JSON.stringify(p.materials ? [p.materials] : []), type: "json" }
    ];

    // 2. Construction de l'objet Produit
    const productPayload = {
      title: p.title,
      body_html: p.description_fr || "",
      vendor: "Richmond Interiors",
      status: p.status === "archived" ? "draft" : "active",
      images: (p.images || []).map(url => ({ src: url })),
      metafields: metafields, // Inclus lors de la création ou mise à jour
      variants: [{
        sku: p.item_code,
        price: String(p.price),
        inventory_management: "shopify",
        inventory_policy: "deny"
      }]
    };

    let shopifyId = p.shopify_product_id;
    let variantId = p.variant_id;
    let exists = false;

    // 3. Vérification existence
    if (shopifyId) {
      try {
        const check = await axios.get(`https://${SHOP}/admin/api/${API_VERSION}/products/${shopifyId}.json`, { headers: HEADERS });
        exists = true;
        variantId = check.data.product.variants[0].id;
      } catch (e) { exists = false; }
    }

    // 4. Action (Create ou Update)
    if (!exists) {
      console.log("➕ Création complète...");
      const res = await axios.post(`https://${SHOP}/admin/api/${API_VERSION}/products.json`, { product: productPayload }, { headers: HEADERS });
      shopifyId = res.data.product.id;
      variantId = res.data.product.variants[0].id;
    } else {
      console.log("✏️ Mise à jour complète...");
      await axios.put(`https://${SHOP}/admin/api/${API_VERSION}/products/${shopifyId}.json`, { 
        product: { id: shopifyId, ...productPayload } 
      }, { headers: HEADERS });
    }

    // 5. Synchronisation du Stock
    if (variantId && p.stock_quantity !== null) {
      try {
        const locRes = await axios.get(`https://${SHOP}/admin/api/${API_VERSION}/locations.json`, { headers: HEADERS });
        const locationId = locRes.data.locations[0].id;

        const varRes = await axios.get(`https://${SHOP}/admin/api/${API_VERSION}/variants/${variantId}.json`, { headers: HEADERS });
        const inventoryItemId = varRes.data.variant.inventory_item_id;

        await axios.post(`https://${SHOP}/admin/api/${API_VERSION}/inventory_levels/set.json`, {
          location_id: locationId,
          inventory_item_id: inventoryItemId,
          available: p.stock_quantity
        }, { headers: HEADERS });
        console.log(`🔢 Stock : ${p.stock_quantity}`);
      } catch (sErr) { console.error("⚠️ Stock error:", sErr.response?.data || sErr.message); }
    }

    // 6. Update Supabase
    await supabase.from("products").update({
      shopify_product_id: String(shopifyId),
      variant_id: String(variantId),
      needs_shopify_update: false,
      last_shopify_sync: new Date().toISOString()
    }).eq("id", p.id);

    console.log("✅ TERMINÉ");
    return res.status(200).json({ ok: true, action: exists ? "updated" : "created" });

  } catch (err) {
    console.error("❌ ERREUR :");
    console.error(err.response?.data || err.message);
    return res.status(500).json({ error: err.message, details: err.response?.data });
  }
}*/
