import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const SHOP = process.env.SHOPIFY_SHOP;
const API_VERSION = "2025-01";
const GQL_URL = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

export default async function handler(req, res) {
  try {
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
        // 1. Recherche de la variante par SKU via GraphQL
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
            .update({ sync_error: "SKU introuvable", last_shopify_sync: new Date().toISOString() })
            .eq("id", p.id);
          results.push({ sku, status: "skipped", reason: "SKU introuvable" });
          continue;
        }

        const variant = edges[0].node;
        const variantGid = variant.id; // ex: "gid://shopify/ProductVariant/123456"
        const oldPrice = parseFloat(variant.price);

        console.log(`--- [${sku}] ---`);
        console.log(`Ancien prix Shopify : ${oldPrice}€`);
        console.log(`Prix Supabase       : ${newPrice}€`);

        // 2. Mise à jour uniquement si le prix a changé
        if (oldPrice !== newPrice) {
          const mutationRes = await axios.post(
            GQL_URL,
            {
              query: `
                mutation productVariantUpdate($input: ProductVariantInput!) {
                  productVariantUpdate(input: $input) {
                    productVariant {
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
                input: {
                  id: variantGid,
                  price: String(newPrice),
                },
              },
            },
            { headers: HEADERS }
          );

          const userErrors = mutationRes.data?.data?.productVariantUpdate?.userErrors;
          if (userErrors && userErrors.length > 0) {
            throw new Error(userErrors.map((e) => e.message).join(", "));
          }

          console.log(`Statut              : ✅ Prix mis à jour (${oldPrice}€ → ${newPrice}€)`);
          results.push({ sku, status: "updated", oldPrice, newPrice });
        } else {
          console.log(`Statut              : ✨ Prix identique, update ignoré`);
          results.push({ sku, status: "skipped", reason: "Prix identique" });
        }

        // 3. Marquer comme synchronisé dans Supabase
        await supabase
          .from("products")
          .update({
            needs_shopify_update: false,
            sync_error: null,
            last_shopify_sync: new Date().toISOString(),
          })
          .eq("id", p.id);

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

