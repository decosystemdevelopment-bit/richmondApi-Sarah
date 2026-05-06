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
    console.log("🚀 DEMARRAGE DU TEST SYNC (1 PRODUIT EXISANT)");
    
    const TOKEN = await getAccessToken();
    const HEADERS = { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" };

    // 1. Récupération du produit avec les logs détaillés
    const { data: products, error } = await supabase
      .from("products")
      .select("*")
      .eq("needs_shopify_update", true)
      .not("shopify_product_id", "is", null) 
      .limit(1);

    if (error) throw error;
    if (!products || products.length === 0) {
      return res.status(200).json({ ok: true, message: "Aucun produit trouvé avec un ID Shopify." });
    }

    const p = products[0];

    // --- AFFICHAGE DES DETAILS DANS LA CONSOLE ---
    console.log("---------------------------------------");
    console.log("🔍 DÉTAILS DU PRODUIT À SYNCHRONISER :");
    console.log(`- ID Interne : ${p.id}`);
    console.log(`- ID Shopify : ${p.shopify_product_id}`);
    console.log(`- Titre      : ${p.title}`);
    console.log(`- Prix       : ${p.price}€`);
    console.log(`- Statut DB  : ${p.status}`);
    console.log(`- Variant ID : ${p.variant_id || "Non spécifié (sera cherché)"}`);
    console.log("---------------------------------------");

    // 2. Test d'accessibilité chez Shopify
    console.log("🧪 Vérification de l'ID chez Shopify...");
    const shopifyCheck = await axios.get(
      `https://${SHOP}/admin/api/${API_VERSION}/products/${p.shopify_product_id}.json`,
      { headers: HEADERS }
    );
    console.log("✅ Produit trouvé sur Shopify.");

    // On récupère le variant ID réel depuis Shopify si celui en DB est faux/vide
    const variantId = p.variant_id || shopifyCheck.data.product.variants[0].id;

    // 3. Mise à jour Shopify
    console.log(`✏️ Envoi de l'update (Prix: ${p.price})...`);
    
    // Update Produit (Titre + Description)
    await axios.put(
      `https://${SHOP}/admin/api/${API_VERSION}/products/${p.shopify_product_id}.json`,
      { product: { id: p.shopify_product_id, title: p.title, body_html: p.description_fr } },
      { headers: HEADERS }
    );

    // Update Variant (Prix)
    await axios.put(
      `https://${SHOP}/admin/api/${API_VERSION}/variants/${variantId}.json`,
      { variant: { id: variantId, price: String(p.price) } },
      { headers: HEADERS }
    );

    // 4. Mise à jour Supabase
    await supabase
      .from("products")
      .update({
        variant_id: variantId,
        needs_shopify_update: false,
        last_shopify_sync: new Date().toISOString()
      })
      .eq("id", p.id);

    console.log("✅ SYNCHRONISATION RÉUSSIE");

    return res.status(200).json({
      status: "success",
      details: {
        title: p.title,
        shopify_id: p.shopify_product_id,
        new_price: p.price
      }
    });

  } catch (err) {
    console.error("❌ ERREUR :");
    if (err.response) {
      console.error(JSON.stringify(err.response.data, null, 2));
    } else {
      console.error(err.message);
    }
    return res.status(500).json({ error: err.message });
  }
}
