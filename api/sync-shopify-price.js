import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const SHOP = process.env.SHOPIFY_SHOP;
const API_VERSION = "2024-01";

export default async function handler(req, res) {
  try {
    const { data: auth } = await supabase.from("shopify_auth").select("access_token").single();
    const HEADERS = { "X-Shopify-Access-Token": auth.access_token, "Content-Type": "application/json" };

    // On utilise ta colonne 'needs_shopify_update'
    const { data: products, error: dbError } = await supabase
      .from("products")
      .select("id, item_code, price, shopify_product_id")
      .eq("needs_shopify_update", true) 
      .limit(20);

    if (dbError) throw dbError;
    if (!products || products.length === 0) return res.status(200).json({ message: "Rien à synchroniser" });

    for (const p of products) {
      try {
        let sId = p.shopify_product_id;
        let vId = null;

        // 1. Récupération des infos de la variante sur Shopify
        // On passe par le SKU car c'est le plus fiable pour trouver la variante
        const checkSku = await axios.get(
          `https://${SHOP}/admin/api/${API_VERSION}/variants.json?sku=${encodeURIComponent(p.item_code)}`, 
          { headers: HEADERS }
        );

        if (checkSku.data.variants && checkSku.data.variants.length > 0) {
          const variant = checkSku.data.variants[0];
          vId = variant.id;
          const oldPrice = variant.price;
          const newPrice = String(p.price);

          // 2. Log de comparaison
          console.log(`--- [${p.item_code}] ---`);
          console.log(`Ancien prix Shopify : ${oldPrice}€`);
          console.log(`Prix Supabase       : ${newPrice}€`);

          if (oldPrice !== newPrice) {
            // 3. Mise à jour du prix
            await axios.put(`https://${SHOP}/admin/api/${API_VERSION}/variants/${vId}.json`, {
              variant: { id: vId, price: newPrice }
            }, { headers: HEADERS });
            console.log(`Statut              : ✅ Prix mis à jour`);
          } else {
            console.log(`Statut              : ✨ Prix déjà identique, update ignoré`);
          }

          // 4. Mise à jour Supabase (Succès)
          await supabase.from("products").update({ 
            needs_shopify_update: false,
            last_shopify_sync: new Date().toISOString()
          }).eq("id", p.id);

        } else {
          console.log(`⚠️ [${p.item_code}] SKU introuvable sur Shopify.`);
          // On marque false pour ne pas bloquer la file d'attente
          await supabase.from("products").update({ needs_shopify_update: false }).eq("id", p.id);
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
