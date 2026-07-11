// Creates a Stripe Checkout Session for one of three fixed coin packages.
// The client only ever sends a package key ('small' | 'medium' | 'large') -
// price and coin amount are looked up server-side from COIN_PACKAGES below,
// so there's nothing in the request itself for a client to tamper with to
// get a better deal. Coins are NOT granted here - only the signature-
// verified stripe-webhook function (after Stripe confirms payment) does that.
import Stripe from "npm:stripe@14";
import { createClient } from "npm:@supabase/supabase-js@2";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
// SUPABASE_URL / SUPABASE_ANON_KEY are auto-injected into every Edge
// Function's environment by Supabase - no need to set them as secrets.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
// The deployed site's own URL, e.g. https://zakqary.github.io/Minogoe -
// this one DOES need to be set manually (supabase secrets set SITE_URL=...),
// since Supabase has no way to know it.
const SITE_URL = Deno.env.get("SITE_URL")!;

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

const COIN_PACKAGES: Record<string, { coins: number; amountCents: number; label: string }> = {
  small: { coins: 10, amountCents: 100, label: "10 Coins" },
  medium: { coins: 60, amountCents: 500, label: "60 Coins" },
  large: { coins: 150, amountCents: 1000, label: "150 Coins" },
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Not authenticated" }, 401);
    }

    // Verifies the caller's Supabase session using their own access token -
    // the anon key alone can't do anything privileged, it just lets us ask
    // Supabase's auth server "who does this token belong to."
    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      return jsonResponse({ error: "Not authenticated" }, 401);
    }

    const body = await req.json().catch(() => ({}));
    const pkg = COIN_PACKAGES[body.package];
    if (!pkg) {
      return jsonResponse({ error: "Unknown coin package" }, 400);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: pkg.label },
          unit_amount: pkg.amountCents,
        },
        quantity: 1,
      }],
      client_reference_id: user.id,
      metadata: { package_id: body.package, coins: String(pkg.coins) },
      success_url: `${SITE_URL}/shop.html?checkout=success`,
      cancel_url: `${SITE_URL}/shop.html?checkout=cancelled`,
    });

    return jsonResponse({ url: session.url });
  } catch (err) {
    console.error("create-checkout-session error:", err);
    return jsonResponse({ error: "Could not start checkout" }, 500);
  }
});
