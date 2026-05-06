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
    console.log("🚀 DEMARRAGE DU TEST SYNC");
    const TOKEN = await getAccessToken();
    const HEADERS = { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" };

    // 1. Récupération du produit
    const { data: products, error } = await supabase
      .from("products")
      .select("*")
      .eq("needs_shopify_update", true)
      .not("shopify_product_id", "is", null) 
      .limit(1);

    if (error) throw error;
    if (!products || products.length === 0) {
      return res.status(200).json({ ok: true, message: "Aucun produit à mettre à jour." });
    }

    const p = products[0];
    console.log(`🔍 ESSAI SUR : ${p.title} (ID Shopify: ${p.shopify_product_id})`);

    try {
      // 2. Tentative de récupération chez Shopify
      const shopifyCheck = await axios.get(
        `https://${SHOP}/admin/api/${API_VERSION}/products/${p.shopify_product_id}.json`,
        { headers: HEADERS }
      );

      const variantId = p.variant_id || shopifyCheck.data.product.variants[0].id;

      // 3. Update Shopify
      console.log(`✏️ Envoi de l'update...`);
      await axios.put(
        `https://${SHOP}/admin/api/${API_VERSION}/products/${p.shopify_product_id}.json`,
        { product: { id: p.shopify_product_id, title: p.title, body_html: p.description_fr } },
        { headers: HEADERS }
      );

      await axios.put(
        `https://${SHOP}/admin/api/${API_VERSION}/variants/${variantId}.json`,
        { variant: { id: variantId, price: String(p.price) } },
        { headers: HEADERS }
      );

      // 4. Update Supabase - Succès
      await supabase
        .from("products")
        .update({
          variant_id: variantId,
          needs_shopify_update: false,
          last_shopify_sync: new Date().toISOString()
        })
        .eq("id", p.id);

      console.log("✅ SYNC RÉUSSIE");
      return res.status(200).json({ ok: true, updated: p.title });

    } catch (err) {
      // 🔥 GESTION DU "NOT FOUND"
      if (err.response && err.response.status === 404) {
        console.error(`⚠️ Le produit ${p.shopify_product_id} n'existe pas sur Shopify. Désactivation du flag.`);
        
        // On remet needs_shopify_update à false pour ne pas bloquer le script sur ce produit
        await supabase
          .from("products")
          .update({ 
            needs_shopify_update: false,
            shopify_product_id: null // Optionnel : on reset l'ID s'il est mort
          })
          .eq("id", p.id);

        return res.status(404).json({ error: "Produit non trouvé sur Shopify, flag désactivé." });
      }
      throw err; // Relance l'erreur si c'est autre chose qu'un 404
    }

  } catch (err) {
    console.error("❌ ERREUR GLOBALE:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
