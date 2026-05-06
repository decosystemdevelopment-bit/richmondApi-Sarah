/**
 * ============================================================
 * Richmond → Supabase Sync
 * ============================================================
 *
 * Objectif :
 * Synchroniser les données produits depuis l'API Richmond
 * vers la base de données Supabase, en détectant uniquement
 * les changements (diff-based sync).
 *
 * ------------------------------------------------------------
 * Fonctionnement global :
 *
 * 1. Récupère les données Richmond via 4 endpoints :
 *    - details (infos produit)
 *    - pricing (prix)
 *    - stock (stock)
 *    - descriptions (contenu)
 *
 * 2. Recompose un objet produit "normalisé" pour chaque item :
 *    → titre, prix, stock, description, images
 *
 * 3. Génère un hash (MD5) basé sur ces données :
 *    → représente l'état du produit à un instant T
 *
 * 4. Compare ce hash avec celui stocké dans Supabase :
 *    - différent → produit modifié
 *    - identique → aucun changement
 *
 * 5. Met à jour la base Supabase avec :
 *    - les nouvelles données
 *    - le nouveau hash
 *    - un flag `needs_shopify_update` si changement détecté
 *
 * ------------------------------------------------------------
 * Pagination :
 * Le script traite les produits par batch (100) via `offset`
 * pour éviter les timeouts Vercel.
 *
 * Exemple :
 * /api/sync-richmond?offset=0
 * /api/sync-richmond?offset=100
 *
 * ------------------------------------------------------------
 * Champs clés :
 *
 * - richmond_hash :
 *   Empreinte du produit → permet de détecter les changements
 *
 * - needs_shopify_update :
 *   Flag utilisé pour déclencher la sync vers Shopify
 *
 * - last_richmond_sync :
 *   Date du dernier passage du script sur ce produit
 *
 * ------------------------------------------------------------
 * Résultat :
 *
 * Ce script alimente Supabase comme source de vérité
 * et prépare uniquement les produits modifiés pour Shopify.
 *
 * Shopify n'est PAS appelé ici.
 *
 * ============================================================
 */


import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const BASE = "https://www.richmondinteriors.nl/api/v1/products";
const AUTH = process.env.RICHMOND_AUTH;

const API = {
  details: `${BASE}/details/${AUTH}`,
  pricing: `${BASE}/pricing/${AUTH}`,
  stock: `${BASE}/stocklevels/${AUTH}`,
  desc: `${BASE}/descriptions/${AUTH}`
};

const COEFF = parseFloat(process.env.PRICE_COEFF || "2.3");

function generateHash(data) {
  return crypto.createHash("md5").update(JSON.stringify(data)).digest("hex");
}

function parsePrice(v) {
  return v ? parseFloat(v.replace(",", ".")) : 0;
}

function parseStock(v) {
  const n = parseInt(String(v || "").replace(/[^\d]/g, ""));
  return isNaN(n) ? 0 : n;
}

function buildImages(p) {
  const base = p["Product Images Location"] || "";
  return (p["Product Images"] || "")
    .split(",")
    .map(i => i.trim())
    .filter(Boolean)
    .map(i => base + i)
    .sort();
}

function mapStatus(p) {
  const raw = (p["Product Status"] || "").toLowerCase();
  return raw.includes("discontinued") ? "archived" : "active";
}

export default async function handler(req, res) {
  try {
    console.log("🔄 Richmond sync...");

    const [productsRes, pricingRes, stockRes, descRes] =
      await Promise.all([
        axios.get(API.details),
        axios.get(API.pricing),
        axios.get(API.stock),
        axios.get(API.desc)
      ]);

    const allProducts = productsRes.data;

    const pricingMap = Object.fromEntries(
      pricingRes.data.map(p => [p.itemCodeNew, p])
    );

    const stockMap = Object.fromEntries(
      stockRes.data.map(s => [s.itemCodeNew, s])
    );

    const descMap = Object.fromEntries(
      descRes.data.map(d => [d.itemCodeNew, d])
    );

    const limit = 100;
    let totalProcessed = 0;

    for (let offset = 0; offset < allProducts.length; offset += limit) {
      const batch = allProducts.slice(offset, offset + limit);
      const codes = batch.map(p => p.itemCodeNew);

      const { data: existingRows } = await supabase
        .from("products")
        .select("item_code, richmond_hash")
        .in("item_code", codes);

      const existingMap = Object.fromEntries(
        (existingRows || []).map(e => [e.item_code, e])
      );

      const upserts = [];

      for (const p of batch) {
        const code = p.itemCodeNew;

        const basePrice = parsePrice(pricingMap[code]?.price);//prix fournisseur
        const finalPrice = Number((basePrice * COEFF).toFixed(2));

        const productData = {
          title: p.description2 || p.description3 || "",
          price: finalPrice,
          richmond_price: basePrice,
          stock: parseStock(stockMap[code]?.onlineAvailabilityText),
          description: (descMap[code]?.longDescriptionFR || "").trim(),
          images: buildImages(p),
          status: mapStatus(p)
        };

        const hash = generateHash(productData);
        const existing = existingMap[code];

        const hasChanged = !existing || existing.richmond_hash !== hash;

        upserts.push({
          item_code: code,
          title: productData.title,
          price: productData.price,
          richmond_price: productData.richmond_price,
          stock_quantity: productData.stock,
          description_fr: productData.description,
          images: productData.images,
          status: productData.status,
          richmond_hash: hash,
          needs_shopify_update: hasChanged,
          last_richmond_sync: new Date().toISOString()
        });
      }

      if (upserts.length > 0) {
        await supabase.from("products").upsert(upserts, {
          onConflict: "item_code"
        });
      }

      totalProcessed += upserts.length;
      console.log(`Batch processed: ${upserts.length}`);
    }

    // 🔥 Gestion produits supprimés
    const allCodes = allProducts.map(p => p.itemCodeNew);

    const { data: dbProducts } = await supabase
      .from("products")
      .select("item_code");

    const deleted = (dbProducts || []).filter(
      p => !allCodes.includes(p.item_code)
    );

    for (const p of deleted) {
      await supabase
        .from("products")
        .update({
          status: "archived",
          needs_shopify_update: true
        })
        .eq("item_code", p.item_code);
    }

    console.log(`🗑️ Archived ${deleted.length}`);
    console.log(`✅ Total processed: ${totalProcessed}`);

    return res.status(200).json({
      ok: true,
      processed: totalProcessed
    });

  } catch (err) {
    console.error("❌ Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
