import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const SHOP = process.env.SHOPIFY_SHOP;
const API_VERSION = "2025-01";
const GQL_URL = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

export default async function handler(req, res) {
  try {
    // 1. Récupération du token
    const { data: auth, error: authError } = await supabase
      .from("shopify_auth")
      .select("access_token")
      .single();

    if (authError || !auth?.access_token) {
      return res.status(401).json({ error: "Token Shopify introuvable ou expiré" });
    }

    const HEADERS = {
      "X-Shopify-Access-Token": auth.access_token,
      "Content-Type": "application/json",
    };

    // 2. Produits à synchroniser
    const { data: products, error: dbError } = await supabase
      .from("products")
      .select("id, item_code, price, shopify_product_id")
      .eq("needs_shopify_update", true)
      .limit(10);

    if (dbError) throw dbError;
    if (!products || products.length === 0) {
      return res.status(200).json({ message: "Rien à synchroniser" });
    }

    const results = [];

    for (const p of products) {
      const sku = p.item_code;
      const newPrice = parseFloat(p.price);

      try {
        // 3. Recherche de la variante par SKU (avec productId)
        const searchRes = await axios.post(
          GQL_URL,
          {
            query: `{
              productVariants(first: 1, query: "sku:${sku}") {
                edges {
                  node {
                    id
                    price
                    sku
                    product {
                      id
                    }
                  }
                }
              }
            }`,
          },
          { headers: HEADERS }
        );

        const edges = searchRes.data?.data?.productVariants?.edges;

        if (!edges || edges.length === 0) {
          console.warn(`⚠️ [${sku}] SKU introuvable sur Shopify.`);
          await supabase
            .from("products")
            .update({
              sync_error: "SKU introuvable",
              last_shopify_sync: new Date().toISOString(),
            })
            .eq("id", p.id);
          results.push({ sku, status: "skipped", reason: "SKU introuvable" });
          continue;
        }

        const variant = edges[0].node;
        const variantGid = variant.id;
        const productGid = variant.product.id;
        const oldPrice = parseFloat(variant.price);

        console.log(`--- [${sku}] ---`);
        console.log(`Ancien prix Shopify : ${oldPrice}€`);
        console.log(`Prix Supabase       : ${newPrice}€`);

        if (oldPrice === newPrice) {
          console.log(`Statut              : ✨ Prix identique, update ignoré`);
          await supabase
            .from("products")
            .update({
              needs_shopify_update: false,
              sync_error: null,
              last_shopify_sync: new Date().toISOString(),
            })
            .eq("id", p.id);
          results.push({ sku, status: "skipped", reason: "Prix identique" });
          continue;
        }

        // 4. Mise à jour via productVariantsBulkUpdate
        const mutationRes = await axios.post(
          GQL_URL,
          {
            query: `
              mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
                productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                  productVariants {
                    id
                    price
                  }
                  userErrors {
                    field
                    message
                  }
                }
              }
            `,
            variables: {
              productId: productGid,
              variants: [
                {
                  id: variantGid,
                  price: String(newPrice),
                },
              ],
            },
          },
          { headers: HEADERS }
        );

        // 5. Vérification des userErrors
        const userErrors = mutationRes.data?.data?.productVariantsBulkUpdate?.userErrors;
        if (userErrors && userErrors.length > 0) {
          throw new Error(userErrors.map((e) => `${e.field}: ${e.message}`).join(", "));
        }

        // 6. Vérification que le prix a bien changé dans la réponse
        const updatedVariant = mutationRes.data?.data?.productVariantsBulkUpdate?.productVariants?.[0];
        const confirmedPrice = updatedVariant ? parseFloat(updatedVariant.price) : null;

        if (confirmedPrice !== null && confirmedPrice !== newPrice) {
          throw new Error(`Prix non appliqué : Shopify retourne ${confirmedPrice}€ au lieu de ${newPrice}€`);
        }

        console.log(`Statut              : ✅ Prix mis à jour (${oldPrice}€ → ${newPrice}€)`);

        // 7. Mise à jour Supabase (succès)
        await supabase
          .from("products")
          .update({
            needs_shopify_update: false,
            sync_error: null,
            last_shopify_sync: new Date().toISOString(),
          })
          .eq("id", p.id);

        results.push({ sku, status: "updated", oldPrice, newPrice, confirmedPrice });

      } catch (err) {
        const errMsg = err.response?.data
          ? JSON.stringify(err.response.data)
          : err.message;
        console.error(`❌ Erreur [${sku}]:`, errMsg);

        // On conserve needs_shopify_update: true pour retry
        await supabase
          .from("products")
          .update({ sync_error: errMsg })
          .eq("id", p.id);

        results.push({ sku, status: "error", error: errMsg });
      }
    }

    return res.status(200).json({ processed: products.length, results });

  } catch (err) {
    console.error("❌ Erreur globale:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
