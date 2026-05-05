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


/* New */
import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

/**
 * 🔌 Supabase
 */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

/**
 * 🌐 Richmond API
 */
const BASE = "https://www.richmondinteriors.nl/api/v1/products";
const AUTH = process.env.RICHMOND_AUTH;

const API = {
  details: `${BASE}/details/${AUTH}`,
  pricing: `${BASE}/pricing/${AUTH}`,
  stock: `${BASE}/stocklevels/${AUTH}`,
  desc: `${BASE}/descriptions/${AUTH}`
};

/**
 * 💰 Pricing
 */
const COEFF = parseFloat(process.env.PRICE_COEFF || "2.3");

/**
 * 🔐 Hash
 */
function generateHash(data) {
  return crypto
    .createHash("md5")
    .update(JSON.stringify(data))
    .digest("hex");
}

/**
 * 💰 Price parser
 */
function parsePrice(value) {
  if (!value) return 0;
  return parseFloat(value.replace(",", "."));
}

/**
 * 📦 Stock parser SAFE
 */
function parseStock(value) {
  if (!value) return 0;

  const num = parseInt(String(value).replace(/[^\d]/g, ""));
  return isNaN(num) ? 0 : num;
}

/**
 * 🖼️ Images builder
 */
function buildImages(p) {
  const base = p["Product Images Location"] || "";

  return (p["Product Images"] || "")
    .split(",")
    .map(i => i.trim())
    .filter(i => i && i.length > 0)
    .map(i => base + i)
    .sort();
}

/**
 * 🧠 Status mapping
 */
function mapStatus(p) {
  const raw = (p["Product Status"] || "").toLowerCase();

  if (raw.includes("discontinued")) return "archived";
  return "active";
}

/**
 * 🚀 Handler
 */
export default async function handler(req, res) {
  try {
    console.log("🔄 Richmond sync...");

    /**
     * 1. FETCH API
     */
    const [productsRes, pricingRes, stockRes, descRes] =
      await Promise.all([
        axios.get(API.details),
        axios.get(API.pricing),
        axios.get(API.stock),
        axios.get(API.desc)
      ]);

    /**
     * 2. MAPS
     */
    const pricingMap = Object.fromEntries(
      pricingRes.data.map(p => [p.itemCodeNew, p])
    );

    const stockMap = Object.fromEntries(
      stockRes.data.map(s => [s.itemCodeNew, s])
    );

    const descMap = Object.fromEntries(
      descRes.data.map(d => [d.itemCodeNew, d])
    );

    /**
     * 3. PAGINATION
     */
    const offset = parseInt(req.query.offset || "0");
    const limit = 100;

    const allProducts = productsRes.data;
    const batch = allProducts.slice(offset, offset + limit);

    const codes = batch.map(p => p.itemCodeNew);

    /**
     * 4. FETCH EXISTING (BULK)
     */
    const { data: existingRows } = await supabase
      .from("products")
      .select("item_code, richmond_hash")
      .in("item_code", codes);

    const existingMap = Object.fromEntries(
      (existingRows || []).map(e => [e.item_code, e])
    );

    const upserts = [];

    /**
     * 5. BUILD PRODUCTS
     */
    for (const p of batch) {
      const code = p.itemCodeNew;

      const priceData = pricingMap[code];
      const stockData = stockMap[code];
      const desc = descMap[code];

      const basePrice = parsePrice(priceData?.retailPrice);
      const finalPrice = Number((basePrice * COEFF).toFixed(2));

      const productData = {
        title: p.description2 || p.description3 || "",
        price: finalPrice,
        richmond_price: basePrice,
        stock: parseStock(stockData?.onlineAvailabilityText),
        description: (desc?.longDescriptionFR || "").trim(),
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

    /**
     * 6. BULK UPSERT
     */
    if (upserts.length > 0) {
      await supabase.from("products").upsert(upserts, {
        onConflict: "item_code"
      });
    }

    /**
     * 7. HANDLE DELETED PRODUCTS (ONLY FIRST PAGE)
     */
    if (offset === 0) {
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

      console.log(`🗑️ Archived ${deleted.length} deleted products`);
    }

    console.log(`✅ Sync done (${upserts.length} produits)`);

    return res.status(200).json({
      ok: true,
      processed: upserts.length
    });

  } catch (err) {
    console.error("❌ Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
