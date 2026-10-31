// Install as api/audit-orphans.js. READ-ONLY: never writes to Shopify or Supabase.
// Lists ACTIVE Shopify products (vendor "Richmond Interiors") that are no longer
// backed by a live Richmond reference in Supabase.
//
// GET /api/audit-orphans            -> JSON report
// GET /api/audit-orphans?format=csv -> CSV of problem products
// Header: Authorization: Bearer <AUDIT_SECRET>
import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";

const VENDOR = "Richmond Interiors";
const TABLE = process.env.SUPABASE_PRODUCT_TABLE || "products_richmond";
const clean = (v) => (v === null || v === undefined ? "" : String(v).trim());

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
  const secret = process.env.AUDIT_SECRET;
  if (!secret) return res.status(503).json({ ok: false, error: "AUDIT_SECRET missing" });
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(req.headers.authorization || "");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  let stage = "configuration";
  try {
    const shop = (process.env.SHOPIFY_SHOP || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
    const version = process.env.SHOPIFY_API_VERSION || "2026-04";
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop) || !key || !process.env.SUPABASE_URL) {
      return res.status(503).json({ ok: false, error: "Check Shopify/Supabase environment variables" });
    }
    const db = createClient(process.env.SUPABASE_URL, key, { auth: { persistSession: false, autoRefreshToken: false } });

    // 1. Shopify token
    stage = "supabase_auth";
    const auth = await db.from("shopify_auth").select("access_token").single();
    if (auth.error || !auth.data?.access_token) throw new Error("Cannot read Shopify token");
    const headers = { "X-Shopify-Access-Token": auth.data.access_token };

    // 2. All Supabase rows (paginated)
    stage = "supabase_products";
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from(TABLE)
        .select("item_code,item_code_new,ean,status,shopify_product_id,shopify_variant_id,legacy:specs->>richmond_item_code_legacy")
        .order("item_code").range(from, from + 999);
      if (error) throw new Error("Supabase read failed");
      rows.push(...data);
      if (data.length < 1000) break;
    }
    const bySku = new Map();      // any known code -> row
    const byProductId = new Map(); // shopify_product_id -> row
    for (const r of rows) {
      for (const c of [r.item_code, r.item_code_new, r.legacy, r.ean].map(clean).filter(Boolean)) {
        if (!bySku.has(c)) bySku.set(c, r);
      }
      if (r.shopify_product_id) byProductId.set(clean(r.shopify_product_id), r);
    }

    // 3. Latest supplier catalogue (optional: detects products removed from the feed
    //    even when the Supabase row was not archived)
    stage = "supabase_catalogue";
    const run = await db.from("richmond_cron_runs").select("started_at,summary")
      .eq("job", "catalogue").eq("status", "success")
      .order("started_at", { ascending: false }).limit(1).maybeSingle();
    const feedCodes = Array.isArray(run.data?.summary?.refresh?.item_codes)
      ? new Set(run.data.summary.refresh.item_codes.map(clean)) : null;

    // 4. Active Richmond products in Shopify (REST, cursor pagination)
    stage = "shopify_read";
    const problems = [];
    let total = 0;
    let url = `https://${shop}/admin/api/${version}/products.json`;
    let params = { limit: 250, status: "active", vendor: VENDOR, fields: "id,title,handle,status,vendor,variants" };
    while (url) {
      const r = await axios.get(url, { headers, params, timeout: 25000, maxRedirects: 0 });
      for (const p of r.data.products || []) {
        total++;
        const skus = (p.variants || []).map((v) => clean(v.sku)).filter(Boolean);
        const row = byProductId.get(String(p.id)) || skus.map((s) => bySku.get(s)).find(Boolean);
        let reason = null;
        if (!row) reason = "not_in_supabase";
        else if (row.status === "archived") reason = "archived_in_supabase";
        else if (feedCodes && !feedCodes.has(clean(row.item_code))) reason = "absent_from_latest_catalogue";
        if (reason) {
          problems.push({
            reason, shopify_product_id: String(p.id), title: p.title, handle: p.handle,
            skus: skus.join("|"), supabase_item_code: row?.item_code || null, supabase_status: row?.status || null
          });
        }
      }
      const next = String(r.headers.link || "").split(",").find((x) => /rel="next"/.test(x));
      url = next?.match(/<([^>]+)>/)?.[1] || null;
      params = undefined; // the next URL already carries the cursor
    }

    if (req.query.format === "csv") {
      const cols = ["reason", "shopify_product_id", "title", "handle", "skus", "supabase_item_code", "supabase_status"];
      const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      return res.status(200).send([cols.join(","), ...problems.map((p) => cols.map((c) => esc(p[c])).join(","))].join("\n"));
    }
    const counts = problems.reduce((a, p) => ((a[p.reason] = (a[p.reason] || 0) + 1), a), {});
    return res.status(200).json({
      ok: true, read_only: true, shopify_active_richmond: total, supabase_rows: rows.length,
      catalogue_checked_at: run.data?.started_at || null, problems_total: problems.length, counts, problems
    });
  } catch (error) {
    // Never return Axios configs: they contain the Shopify token.
    return res.status(502).json({ ok: false, stage, upstream_status: error.response?.status || null, error: "Audit failed" });
  }
}
