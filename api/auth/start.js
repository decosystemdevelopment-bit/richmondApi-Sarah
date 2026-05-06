export default async function handler(req, res) {
  const shop = process.env.SHOPIFY_SHOP;

  const url = `https://${shop}/admin/oauth/authorize?client_id=${process.env.SHOPIFY_CLIENT_ID}&scope=${process.env.SHOPIFY_SCOPES}&redirect_uri=${process.env.SHOPIFY_REDIRECT_URI}`;

  res.redirect(url);
}
