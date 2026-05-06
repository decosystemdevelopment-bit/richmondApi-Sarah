import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const SHOP = process.env.SHOPIFY_SHOP;
const API_VERSION = "2024-01";

export default async function handler(req, res) {
  try {
    const { data: auth } = await supabase.from("shopify_auth").select("access_token").single();
    if (!auth?.access_token) throw new Error("Missing Shopify Token");
    
    const HEADERS = { "X-Shopify-Access-Token": auth.access_token, "Content-Type": "application/json" };

    const { data: products, error: dbError } = await supabase
      .from("products")
      .select("*")
      .eq("needs_shopify_update", true)
      .limit(5);

    if (dbError) throw dbError;
    if (!products || products.length === 0) return res.status(200).json({ message: "Rien à synchroniser" });

    const locRes = await axios.get(`https://${SHOP}/admin/api/${API_VERSION}/locations.json`, { headers: HEADERS });
    const locationId = locRes.data.locations[0].id;

    for (const p of products) {
      try {
        console.log(`--- Traitement SKU: ${p.item_code} ---`);

        let shopifyId = (p.shopify_product_id && p.shopify_product_id !== "null") ? p.shopify_product_id : null;
        let variantId = (p.variant_id && p.variant_id !== "null") ? p.variant_id : null;

        // 1. RECHERCHE PAR SKU (Sécurité Sidekick)
        if (!shopifyId) {
          const checkSku = await axios.get(
            `https://${SHOP}/admin/api/${API_VERSION}/variants.json?sku=${encodeURIComponent(p.item_code)}`, 
            { headers: HEADERS }
          );
          if (checkSku.data.variants && checkSku.data.variants.length > 0) {
            shopifyId = checkSku.data.variants[0].product_id;
            variantId = checkSku.data.variants[0].id;
          }
        }

        // 2. PRÉPARATION DES METAFIELDS
        const metafields = [
          { namespace: "custom", key: "volume", value: String(p.volume || 0), type: "number_decimal" },
          { namespace: "custom", key: "weight", value: String(p.weight || 0), type: "number_decimal" },
          { namespace: "custom", key: "depth", value: String(p.depth || 0), type: "number_decimal" },
          { namespace: "custom", key: "height", value: String(p.height || 0), type: "number_decimal" },
          { namespace: "custom", key: "width", value: String(p.width || 0), type: "number_decimal" },
          { namespace: "custom", key: "color_richmond", value: p.color || "N/A", type: "single_line_text_field" },
          { namespace: "custom", key: "materials_richmond", value: JSON.stringify(p.materials ? p.materials.split('|') : []), type: "json" }
        ];

        // 3. PAYLOAD GLOBAL
        const payload = {
          product: {
            title: p.title,
            body_html: p.description_fr || "",
            vendor: "Richmond Interiors",
            status: p.status === "archived" ? "archived" : "active",
            images: (p.images || []).map(url => ({ src: url })),
            metafields: metafields, // Injectés ici pour création ET mise à jour
            variants: [{
              sku: p.item_code,
              price: String(p.price || 0),
              inventory_management: "shopify"
            }]
          }
        };

        // 4. EXECUTION (POST ou PUT)
        if (shopifyId) {
          const upRes = await axios.put(`https://${SHOP}/admin/api/${API_VERSION}/products/${shopifyId}.json`, payload, { headers: HEADERS });
          variantId = upRes.data.product.variants[0].id;
          console.log(`✅ ${p.item_code} (Update + Metafields)`);
        } else {
          const creRes = await axios.post(`https://${SHOP}/admin/api/${API_VERSION}/products.json`, payload, { headers: HEADERS });
          shopifyId = creRes.data.product.id;
          variantId = creRes.data.product.variants[0].id;
          console.log(`✅ ${p.item_code} (Create + Metafields)`);
          
          // Sync ID immédiate pour éviter doublon si le stock plante
          await supabase.from("products").update({ shopify_product_id: String(shopifyId), variant_id: String(variantId) }).eq("id", p.id);
        }

        // 5. STOCK (Inventory Level)
        const varRes = await axios.get(`https://${SHOP}/admin/api/${API_VERSION}/variants/${variantId}.json`, { headers: HEADERS });
        const invId = varRes.data.variant.inventory_item_id;

        await axios.post(`https://${SHOP}/admin/api/${API_VERSION}/inventory_levels/set.json`, {
          location_id: locationId,
          inventory_item_id: invId,
          available: parseInt(p.stock_quantity || 0)
        }, { headers: HEADERS });

        // 6. FIN
        await supabase.from("products").update({ needs_shopify_update: false, last_shopify_sync: new Date().toISOString() }).eq("id", p.id);

      } catch (err) {
        console.error(`❌ Erreur ${p.item_code}:`, err.response?.data || err.message);
        await supabase.from("products").update({ needs_shopify_update: false }).eq("id", p.id);
      }
    }
    return res.status(200).json({ ok: true, count: products.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
/*
fonctionne mais cinquante produit fait sauté le programme donc il se coupe

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
      .limit(50); 

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
*/
