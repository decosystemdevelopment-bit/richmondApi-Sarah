
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
    console.log("🚀 START BATCH SYNC (50 PRODUITS)");
    const TOKEN = await getAccessToken();
    const HEADERS = { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" };

    const { data: products, error } = await supabase
      .from("products")
      .select("*")
      .eq("needs_shopify_update", true)
      .limit(10); 

    if (error) throw error;
    if (!products || products.length === 0) return res.status(200).json({ ok: true, message: "Rien à synchroniser." });

    // On récupère la Location une seule fois
    const locRes = await axios.get(`https://${SHOP}/admin/api/${API_VERSION}/locations.json`, { headers: HEADERS });
    const locationId = locRes.data.locations[0].id;

    for (const p of products) {
      try {
        console.log(`--- 🛠 ${p.item_code} ---`);

        const metafields = [
          { namespace: "custom", key: "volume", value: String(p.volume || 0), type: "number_decimal" },
          { namespace: "custom", key: "weight", value: String(p.weight || 0), type: "number_decimal" },
          { namespace: "custom", key: "depth", value: String(p.depth || 0), type: "number_decimal" },
          { namespace: "custom", key: "height", value: String(p.height || 0), type: "number_decimal" },
          { namespace: "custom", key: "width", value: String(p.width || 0), type: "number_decimal" },
          { namespace: "custom", key: "color_richmond", value: p.color || "N/A", type: "single_line_text_field" },
          { namespace: "custom", key: "materials_richmond", value: JSON.stringify(p.materials ? p.materials.split('|') : []), type: "json" }
        ];

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
            inventory_management: "shopify"
          }]
        };

        let shopifyId = p.shopify_product_id;
        let variantId = null;

        // 1. UPDATE OU CREATE (et on capture la réponse pour avoir le variant_id)
        if (shopifyId) {
          try {
            const upRes = await axios.put(`https://${SHOP}/admin/api/${API_VERSION}/products/${shopifyId}.json`, { product: { id: shopifyId, ...productPayload } }, { headers: HEADERS });
            variantId = upRes.data.product.variants[0].id;
            console.log("✅ Produit mis à jour");
          } catch (e) {
            console.log("⚠️ ID inexistant sur Shopify, passage en création...");
            shopifyId = null;
          }
        }

        if (!shopifyId) {
          const creRes = await axios.post(`https://${SHOP}/admin/api/${API_VERSION}/products.json`, { product: productPayload }, { headers: HEADERS });
          shopifyId = creRes.data.product.id;
          variantId = creRes.data.product.variants[0].id;
          console.log("✅ Produit créé");
        }

        // 2. SYNC STOCK (Sécurisé avec le variantId tout neuf)
        if (variantId) {
          try {
            const varRes = await axios.get(`https://${SHOP}/admin/api/${API_VERSION}/variants/${variantId}.json`, { headers: HEADERS });
            const invItemId = varRes.data.variant.inventory_item_id;

            // On s'assure que le suivi est activé
            await axios.put(`https://${SHOP}/admin/api/${API_VERSION}/inventory_items/${invItemId}.json`, { inventory_item: { tracked: true } }, { headers: HEADERS });

            // On injecte la quantité
            await axios.post(`https://${SHOP}/admin/api/${API_VERSION}/inventory_levels/set.json`, {
              location_id: locationId,
              inventory_item_id: invItemId,
              available: parseInt(p.stock_quantity || 0)
            }, { headers: HEADERS });
            
            console.log(`🔢 Stock réglé sur : ${p.stock_quantity}`);
          } catch (stockErr) {
            console.error(`❌ Erreur Stock ${p.item_code}:`, stockErr.response?.data || stockErr.message);
          }
        }

        // 3. UPDATE SUPABASE
        await supabase.from("products").update({
          shopify_product_id: String(shopifyId),
          variant_id: String(variantId),
          needs_shopify_update: false,
          last_shopify_sync: new Date().toISOString()
        }).eq("id", p.id);

      } catch (prodErr) {
        console.error(`🔴 Erreur Critique sur ${p.item_code}:`, prodErr.response?.data || prodErr.message);
      }
    }

    return res.status(200).json({ ok: true, count: products.length });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
/*

update dizaine de produit mais error stock

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
    console.log("🚀 START GLOBAL SYNC BATCH");
    const TOKEN = await getAccessToken();
    const HEADERS = { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" };

    // 1. On récupère les 10 prochains produits à synchroniser
    const { data: products, error } = await supabase
      .from("products")
      .select("*")
      .eq("needs_shopify_update", true)
      .limit(10); // Batch de 10 pour la sécurité

    if (error) throw error;
    if (!products || products.length === 0) {
      return res.status(200).json({ ok: true, message: "Tout est déjà à jour." });
    }

    console.log(`📦 Batch trouvé : ${products.length} produits à traiter.`);

    const results = [];

    // 2. Boucle de traitement
    for (const p of products) {
      try {
        console.log(`--- 🛠 Syncing: ${p.title} (${p.item_code}) ---`);

        // A. Préparation des données
        const metafields = [
          { namespace: "custom", key: "volume", value: String(p.volume || 0), type: "number_decimal" },
          { namespace: "custom", key: "weight", value: String(p.weight || 0), type: "number_decimal" },
          { namespace: "custom", key: "depth", value: String(p.depth || 0), type: "number_decimal" },
          { namespace: "custom", key: "height", value: String(p.height || 0), type: "number_decimal" },
          { namespace: "custom", key: "width", value: String(p.width || 0), type: "number_decimal" },
          { namespace: "custom", key: "color_richmond", value: p.color || "N/A", type: "single_line_text_field" },
          { 
            namespace: "custom", 
            key: "materials_richmond", 
            value: JSON.stringify(p.materials ? p.materials.split('|') : []), 
            type: "json" 
          }
        ];

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
            inventory_management: "shopify"
          }]
        };

        let shopifyId = p.shopify_product_id;
        let variantId = p.variant_id;
        let exists = false;

        // B. Vérification existence / Update ou Create
        if (shopifyId) {
          try {
            const check = await axios.get(`https://${SHOP}/admin/api/${API_VERSION}/products/${shopifyId}.json`, { headers: HEADERS });
            exists = true;
            variantId = check.data.product.variants[0].id;
          } catch (e) { exists = false; }
        }

        if (!exists) {
          const createRes = await axios.post(`https://${SHOP}/admin/api/${API_VERSION}/products.json`, { product: productPayload }, { headers: HEADERS });
          shopifyId = createRes.data.product.id;
          variantId = createRes.data.product.variants[0].id;
          console.log("✅ Created");
        } else {
          await axios.put(`https://${SHOP}/admin/api/${API_VERSION}/products/${shopifyId}.json`, { product: { id: shopifyId, ...productPayload } }, { headers: HEADERS });
          console.log("✅ Updated");
        }

        // C. Synchronisation du Stock (Forçage tracked)
        const varRes = await axios.get(`https://${SHOP}/admin/api/${API_VERSION}/variants/${variantId}.json`, { headers: HEADERS });
        const invItemId = varRes.data.variant.inventory_item_id;

        await axios.put(`https://${SHOP}/admin/api/${API_VERSION}/inventory_items/${invItemId}.json`, { inventory_item: { tracked: true } }, { headers: HEADERS });

        const locRes = await axios.get(`https://${SHOP}/admin/api/${API_VERSION}/locations.json`, { headers: HEADERS });
        const locId = locRes.data.locations[0].id;

        await axios.post(`https://${SHOP}/admin/api/${API_VERSION}/inventory_levels/set.json`, {
          location_id: locId,
          inventory_item_id: invItemId,
          available: parseInt(p.stock_quantity || 0)
        }, { headers: HEADERS });

        // D. Mise à jour Supabase pour ce produit précis
        await supabase.from("products").update({
          shopify_product_id: String(shopifyId),
          variant_id: String(variantId),
          needs_shopify_update: false,
          last_shopify_sync: new Date().toISOString()
        }).eq("id", p.id);

        results.push({ item_code: p.item_code, status: "success" });

      } catch (prodError) {
        console.error(`❌ Erreur sur le produit ${p.item_code}:`, prodError.response?.data || prodError.message);
        results.push({ item_code: p.item_code, status: "error", error: prodError.message });
      }
    }

    return res.status(200).json({ ok: true, processed: results });

  } catch (err) {
    console.error("❌ GLOBAL ERROR:", err.message);
    return res.status(500).json({ error: err.message });
  }
}*/
/*
// ce dernier script c'était pour corriger un produit spécifique
//correctif stock, variant_id manquant

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
    console.log("🚀 SYNC STOCK : Récupération du Variant ID manquant...");
    const TOKEN = await getAccessToken();
    const HEADERS = { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" };

    // 1. Sélection du produit Oravelle
    const { data: p, error } = await supabase
      .from("products")
      .select("*")
      .eq("id", "00136d52-fc0e-48f8-b50b-769f5c10fe3f") 
      .single();

    if (error || !p) throw new Error("Produit non trouvé");
    if (!p.shopify_product_id) throw new Error("Le shopify_product_id est manquant. Création requise d'abord.");

    let variantId = p.variant_id;

    // 2. RÉCUPÉRATION SI MANQUANT
    if (!variantId) {
      console.log(`🔍 Variant ID manquant en DB pour ${p.shopify_product_id}. Récupération chez Shopify...`);
      const prodRes = await axios.get(
        `https://${SHOP}/admin/api/${API_VERSION}/products/${p.shopify_product_id}.json`,
        { headers: HEADERS }
      );
      
      // On prend le premier variant trouvé
      variantId = prodRes.data.product.variants[0].id;
      
      // On enregistre tout de suite en DB pour ne plus avoir l'erreur
      await supabase.from("products")
        .update({ variant_id: String(variantId) })
        .eq("id", p.id);
        
      console.log(`✅ Variant ID trouvé (${variantId}) et enregistré dans Supabase.`);
    }

    // 3. RÉCUPÉRATION DE L'INVENTAIRE ITEM
    const varRes = await axios.get(
      `https://${SHOP}/admin/api/${API_VERSION}/variants/${variantId}.json`, 
      { headers: HEADERS }
    );
    const inventoryItemId = varRes.data.variant.inventory_item_id;

    // 4. FORCER LE SUIVI (Tracked)
    await axios.put(
      `https://${SHOP}/admin/api/${API_VERSION}/inventory_items/${inventoryItemId}.json`, 
      { inventory_item: { tracked: true } }, 
      { headers: HEADERS }
    );

    // 5. RÉCUPÉRER LOCATION ET METTRE À JOUR STOCK
    const locRes = await axios.get(`https://${SHOP}/admin/api/${API_VERSION}/locations.json`, { headers: HEADERS });
    const locationId = locRes.data.locations[0].id;

    const realStock = parseInt(p.stock_quantity || 0);

    await axios.post(
      `https://${SHOP}/admin/api/${API_VERSION}/inventory_levels/set.json`, 
      {
        location_id: locationId,
        inventory_item_id: inventoryItemId,
        available: realStock
      }, 
      { headers: HEADERS }
    );

    // 6. FINALISATION
    await supabase.from("products").update({
      needs_shopify_update: false,
      last_shopify_sync: new Date().toISOString()
    }).eq("id", p.id);

    console.log(`✅ SUCCÈS : Stock mis à jour (${realStock} unités)`);
    
    return res.status(200).json({ ok: true, variant_id_recovered: variantId, stock: realStock });

  } catch (err) {
    console.error("❌ ERREUR :");
    console.error(err.response?.data || err.message);
    return res.status(500).json({ error: err.message, details: err.response?.data });
  }
}*/
/*

celui la est parfait excepté le stock.

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
*/
