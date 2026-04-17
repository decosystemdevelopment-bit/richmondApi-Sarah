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

/**
 * 🔌 Initialisation du client Supabase
 * Utilise les variables d'environnement (sécurité)
 */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

/**
 * 🌐 Configuration API Richmond
 * Richmond expose plusieurs endpoints séparés (details, pricing, stock, descriptions)
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
 * 🧠 Génère un hash unique du produit
 * Permet de détecter si un produit a changé (comparaison avec la DB)
 */
function generateHash(data) {
  return crypto
    .createHash("md5")
    .update(JSON.stringify(data)) // stringify pour garantir une comparaison fiable
    .digest("hex");
}

/**
 * 🚀 Endpoint Vercel
 * Synchronise Richmond → Supabase
 */
export default async function handler(req, res) {
  try {
    console.log("🔄 Richmond sync...");

    /**
     * 📡 Récupération des données Richmond en parallèle
     * Optimisation : Promise.all pour réduire le temps de réponse
     */
    const [productsRes, pricingRes, stockRes, descRes] =
      await Promise.all([
        axios.get(API.details),
        axios.get(API.pricing),
        axios.get(API.stock),
        axios.get(API.desc)
      ]);

    /**
     * 🗺️ Transformation en maps (lookup rapide O(1))
     * Permet d'éviter des recherches dans des tableaux (O(n))
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
     * 📦 Pagination
     * Évite les timeouts Vercel en traitant les produits par batch
     */
    const offset = parseInt(req.query.offset || "0");
    const limit = 100;

    const products = productsRes.data.slice(offset, offset + limit);

    /**
     * 🔁 Boucle sur chaque produit Richmond
     */
    for (const p of products) {
      const code = p.itemCodeNew;

      // 🔗 Récupération des données liées (prix, stock, description)
      const priceData = pricingMap[code];
      const stockData = stockMap[code];
      const desc = descMap[code];

      /**
       * 🧱 Reconstruction d'un objet produit "stable"
       * Important pour garantir un hash cohérent
       */
      const productData = {
        title: p.description2 || p.description3,

        // 💰 Normalisation du prix (évite 41.4 vs 41.40)
        price: Number(
          parseFloat(priceData?.retailPrice?.replace(",", ".") || 0).toFixed(2)
        ),

        // 📦 Stock converti en entier
        stock: parseInt(stockData?.StockIndicator) || 0,

        // 📝 Nettoyage description (évite différences invisibles)
        description: (desc?.longDescriptionFR || "").trim(),

        // 🖼️ Normalisation images (ordre stable)
        images: (p["Product Images"] || "")
          .split(",")
          .map(i => i.trim())
          .sort()
      };

      /**
       * 🔑 Génération du hash produit
       */
      const hash = generateHash(productData);

      /**
       * 🔍 Récupération du hash existant en base
       */
      const { data: existing } = await supabase
        .from("products")
        .select("richmond_hash")
        .eq("item_code", code)
        .maybeSingle();

      /**
       * ⚖️ Détection de changement
       * - nouveau produit → true
       * - produit modifié → true
       * - sinon → false
       */
      const hasChanged = !existing || existing.richmond_hash !== hash;

      // 🔎 Logs debug
      console.log("Produit:", code);
      console.log("Nouveau hash:", hash);
      console.log("Ancien hash:", existing?.richmond_hash);

      /**
       * 💾 UPSERT (insert ou update)
       * Met à jour les données + flag Shopify si nécessaire
       */
      await supabase.from("products").upsert({
        item_code: code,
        title: productData.title,
        price: productData.price,
        stock_quantity: productData.stock,
        description_fr: productData.description,
        images: productData.images,

        richmond_hash: hash,
        needs_shopify_update: hasChanged,
        last_richmond_sync: new Date().toISOString()
      }, {
        onConflict: "item_code"
      });
    }

    console.log("✅ Richmond sync done");

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("❌ Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
