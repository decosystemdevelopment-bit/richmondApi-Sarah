import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const SHOP = process.env.SHOPIFY_SHOP;
const API_VERSION = "2024-01";

export default async function handler(req, res) {
  try {
    const { data: auth } = await supabase.from("shopify_auth").select("access_token").single();
    const HEADERS = { "X-Shopify-Access-Token": auth.access_token, "Content-Type": "application/json" };

    // Sélection des produits nécessitant une mise à jour de prix
    const { data: products } = await supabase
      .from("products")
      .select("id, item_code, price, variant_id")
      .eq("needs_price_update", true)
      .limit(25);

    if (!products || products.length === 0) return res.status(200).json({ message: "Aucun prix à modifier" });

    for (const p of products) {
      try {
        let vId = (p.variant_id && p.variant_id !== "null") ? p.variant_id : null;

        // 1. Si on n'a pas l'ID de variante, on le récupère via le SKU
        if (!vId) {
          const checkSku = await axios.get(
            `https://${SHOP}/admin/api/${API_VERSION}/variants.json?sku=${encodeURIComponent(p.item_code)}`, 
            { headers: HEADERS }
          );
          if (checkSku.data.variants?.length > 0) {
            vId = checkSku.data.variants[0].id;
          }
        }

        if (vId) {
          // 2. RÉCUPÉRATION DU PRIX ACTUEL SUR SHOPIFY (pour le log)
          const currentVariantRes = await axios.get(
            `https://${SHOP}/admin/api/${API_VERSION}/variants/${vId}.json`, 
            { headers: HEADERS }
          );
          const oldPriceShopify = currentVariantRes.data.variant.price;
          const newPriceSupabase = String(p.price);

          // 3. MISE À JOUR SI DIFFÉRENT (Optimisation)
          if (oldPriceShopify !== newPriceSupabase) {
            await axios.put(`https://${SHOP}/admin/api/${API_VERSION}/variants/${vId}.json`, {
              variant: { id: vId, price: newPriceSupabase }
            }, { headers: HEADERS });

            console.log(`💰 [${p.item_code}] SYNC PRIX :`);
            console.log(`   - Ancien prix Shopify : ${oldPriceShopify}€`);
            console.log(`   - Prix dans Supabase   : ${newPriceSupabase}€`);
            console.log(`   - Statut              : ✅ Mis à jour`);
          } else {
            console.log(`✨ [${p.item_code}] Déjà à jour (${oldPriceShopify}€)`);
          }

          // 4. Mise à jour Supabase pour libérer la file
          await supabase.from("products").update({ 
            variant_id: String(vId),
            needs_price_update: false 
          }).eq("id", p.id);

        } else {
          console.log(`⚠️ [${p.item_code}] SKU introuvable sur Shopify. Impossible de mettre à jour le prix.`);
          await supabase.from("products").update({ needs_price_update: false }).eq("id", p.id);
        }

      } catch (err) {
        console.error(`❌ Erreur [${p.item_code}]:`, err.response?.data || err.message);
      }
    }

    return res.status(200).json({ processed: products.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
