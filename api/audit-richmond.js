// Upload as api/audit-richmond.js. Strictly read-only.
import axios from "axios";
import { timingSafeEqual } from "node:crypto";

const endpoints = {
  details: "details", pricing: "pricing",
  stock: "stocklevels", descriptions: "descriptions"
};

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
  const secret = process.env.AUDIT_SECRET;
  if (!secret) return res.status(503).json({ ok: false, error: "AUDIT_SECRET missing" });
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(req.headers.authorization || "");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  const dataset = req.query.dataset;
  if (typeof dataset !== "string" || !Object.hasOwn(endpoints, dataset)) {
    return res.status(400).json({ ok: false, error: "dataset must be details, pricing, stock or descriptions" });
  }
  const auth = (process.env.RICHMOND_AUTH || "").replace(/^\/+|\/+$/g, "");
  if (!auth) return res.status(503).json({ ok: false, error: "RICHMOND_AUTH missing" });
  try {
    const response = await axios.get(
      `https://www.richmondinteriors.nl/api/v1/products/${endpoints[dataset]}/${auth}`,
      { timeout: 25000, maxRedirects: 0 }
    );
    if (!Array.isArray(response.data) || response.data.length === 0) {
      return res.status(502).json({ ok: false, error: "Richmond returned an empty or invalid dataset", dataset });
    }
    return res.status(200).json({
      ok: true, read_only: true, dataset,
      fetched_at: new Date().toISOString(), count: response.data.length, rows: response.data
    });
  } catch (error) {
    // Do not log/return the upstream URL: it contains the supplier credential.
    return res.status(502).json({ ok: false, dataset,
      upstream_status: error.response?.status || null,
      error: "Richmond read failed; no data was modified" });
  }
}
