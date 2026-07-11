// Stripe calls this directly, server-to-server - there is no Supabase user
// session on this request at all. Deployed with --no-verify-jwt for exactly
// that reason. Every request MUST have its signature verified against
// STRIPE_WEBHOOK_SECRET before anything here is trusted - that verification
// is the ONLY thing standing between this endpoint and someone just POSTing
// a fake "payment completed" event straight at it to grant themselves coins.
import Stripe from "npm:stripe@14";
import { createClient } from "npm:@supabase/supabase-js@2";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are auto-injected into every Edge
// Function's environment by Supabase - no need to set them as secrets. The
// service role key bypasses RLS entirely, which is required here since
// coin_purchases has no insert policy for anyone but this function.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing signature", { status: 400 });
  }

  // Signature verification needs the exact raw bytes Stripe signed -
  // parsing as JSON first (even just to re-stringify later) can change
  // whitespace/key ordering enough to break verification.
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return new Response("Invalid signature", { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.client_reference_id;
    const packageId = session.metadata?.package_id;
    const coins = Number(session.metadata?.coins);

    if (!userId || !packageId || !Number.isFinite(coins) || coins <= 0) {
      console.error("checkout.session.completed missing expected fields, session:", session.id);
      // Acknowledge anyway - Stripe retries on non-2xx, and retrying won't
      // fix a session that was created without the expected metadata.
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }

    // grant_coin_purchase() is idempotent (unique on stripe_session_id), so
    // a redelivered webhook for a session already processed is a safe no-op.
    const { error } = await supabaseAdmin.rpc("grant_coin_purchase", {
      p_user_id: userId,
      p_stripe_session_id: session.id,
      p_package_id: packageId,
      p_coins: coins,
      p_amount_cents: session.amount_total ?? 0,
    });

    if (error) {
      console.error("grant_coin_purchase failed:", error);
      return new Response(JSON.stringify({ error: "Could not grant coins" }), { status: 500 });
    }
  }

  return new Response(JSON.stringify({ received: true }), { status: 200 });
});
