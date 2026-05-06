import axios from "axios";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export default async function handler(req, res) {
  const { code, shop } = req.query;

  try {
    const tokenRes = await axios.post(
      `https://${shop}/admin/oauth/access_token`,
      {
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
        code
      }
    );

    const access_token = tokenRes.data.access_token;

    console.log("✅ TOKEN:", access_token);

    /**
     * 💾 Sauvegarde dans Supabase
     */
    await supabase
      .from("shopify_auth")
      .upsert({
        shop,
        access_token,
        updated_at: new Date().toISOString()
      }, { onConflict: "shop" });

    return res.send("✅ Shopify connecté !");

  } catch (err) {
    console.error(err.response?.data || err.message);
    return res.status(500).send("OAuth error");
  }
}
