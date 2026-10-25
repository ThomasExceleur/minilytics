-- Stripe webhook signing secret (whsec_...) per site.
ALTER TABLE sites ADD COLUMN stripe_webhook_secret TEXT;

-- Lets a refund (which names the PaymentIntent / charge) and a return page
-- (?session_id=cs_...) find the payment row when that row is keyed by the invoice id.
ALTER TABLE payments ADD COLUMN payment_intent_id TEXT;
ALTER TABLE payments ADD COLUMN checkout_session_id TEXT;
