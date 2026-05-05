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

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const AUTH = process.env.RICHMOND_AUTH;
const BASE = "https://www.richmondinteriors.nl/api/v1/products";
const API = {
  details: `${BASE}/details/${AUTH}`,
  pricing: `${BASE}/pricing/${AUTH}`,
  stock: `${BASE}/stocklevels/${AUTH}`,
  desc: `${BASE}/descriptions/${AUTH}`
};

const COEFF = parseFloat(process.env.PRICE_COEFF || "2.3");

const generateHash = (data) => crypto.createHash("md5").update(JSON.stringify(data)).digest("hex");
const parsePrice = (v) => parseFloat(String(v || "0").replace(",", ".")) || 0;
const parseStock = (v) => parseInt(String(v || "0").replace(/[^\d]/g, "")) || 0;

export default async function handler(req, res) {
  try {
    console.log("🚀 Starting Richmond Sync...");

    // 1. Fetch de toutes les sources en parallèle
    const [dRes, pRes, sRes, deRes] = await Promise.all([
      axios.get(API.details), axios.get(API.pricing),
      axios.get(API.stock), axios.get(API.desc)
    ]);

    const pricingMap = Object.fromEntries(pRes.data.map(i => [i.itemCodeNew, i]));
    const stockMap = Object.fromEntries(sRes.data.map(i => [i.itemCodeNew, i]));
    const descMap = Object.fromEntries(deRes.data.map(i => [i.itemCodeNew, i]));

    const allProducts = dRes.data;
    const batchSize = 100;
    let totalUpdated = 0;

    // 2. Traitement par lots pour Supabase
    for (let i = 0; i < allProducts.length; i += batchSize) {
      const batch = allProducts.slice(i, i + batchSize);
      const codes = batch.map(p => p.itemCodeNew);

      // Récupérer les hashs existants
      const { data: existingRows } = await supabase
        .from("products")
        .select("item_code, richmond_hash")
        .in("item_code", codes);

      const existingMap = Object.fromEntries((existingRows || []).map(r => [r.item_code, r]));
      const upserts = [];

      for (const p of batch) {
        const code = p.itemCodeNew;
        const price = parsePrice(pricingMap[code]?.retailPrice);
        
        // Données pour le Hash (détection de changement)
        const syncData = {
          title: p.description2 || p.description3 || "Sans titre",
          price: Number((price * COEFF).toFixed(2)),
          stock_quantity: parseStock(stockMap[code]?.onlineAvailabilityText),
          description_fr: (descMap[code]?.longDescriptionFR || "").trim(),
          status: (p["Product Status"] || "").toLowerCase().includes("discontinued") ? "archived" : "active"
        };

        const newHash = generateHash(syncData);
        const hasChanged = !existingMap[code] || existingMap[code].richmond_hash !== newHash;

        upserts.push({
          item_code: code,
          ...syncData,
          richmond_price: price,
          richmond_hash: newHash,
          needs_shopify_update: hasChanged,
          last_richmond_sync: new Date().toISOString(),
          images: (p["Product Images"] || "").split(",").filter(img => img).map(img => (p["Product Images Location"] || "") + img.trim())
        });
      }

      if (upserts.length > 0) {
        const { error } = await supabase.from("products").upsert(upserts, { onConflict: "item_code" });
        if (error) throw error;
        totalUpdated += upserts.length;
      }
    }

    // 3. Soft-delete (Archive) les produits disparus du flux
    const allCodes = allProducts.map(p => p.itemCodeNew);
    await supabase
      .from("products")
      .update({ status: 'archived', needs_shopify_update: true })
      .not('item_code', 'in', `(${allCodes.join(',')})`)
      .neq('status', 'archived');

    res.status(200).json({ ok: true, processed: totalUpdated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
