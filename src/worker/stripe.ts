import type { Context } from 'hono';
import { getSite, type AppEnv, type Site } from './env';
import { resolveVisitor } from './identity';
import { verifyStripeWebhook } from './lib/crypto';
import { creditedSessionSql, recordPayment } from './payments';

/**
 * Stripe revenue attribution.
 *
 * One-off Checkout payments come from `checkout.session.completed` (and
 * `checkout.session.async_payment_succeeded` for delayed methods).
 * Subscription charges — the first invoice and every renewal — come from
 * `invoice.paid`. A paid subscription Checkout Session is stored under the
 * same invoice id, so the two events collapse to one row.
 * Refunds come from `charge.refunded` (one row per refund id) or, if the
 * charge has no refund list, one cumulative row per charge.
 * Retries are idempotent: the payment id is the Stripe object id.
 */

const VISITOR_KEYS = ['ml_visitor_id', 'visitor_id', 'minilytics_visitor_id'];
const SESSION_KEYS = ['ml_session_id', 'session_id', 'minilytics_session_id'];
const SUBSCRIPTION_REASONS = new Set([
  'subscription_create',
  'subscription_cycle',
  'subscription_update',
  'subscription_threshold',
  'subscription',
]);

export interface StripePaymentDraft {
  id: string;
  ts: number;
  amount: number; // minor units; negative for refunds
  kind: 'payment' | 'refund';
  currency: string;
  visitorId: string | null;
  sessionId: string | null;
  customerId: string | null;
  email: string | null;
  name: string | null;
  subscriptionId: string | null;
  paymentIntentId: string | null;
  checkoutSessionId: string | null;
  /** Extra payment_claims keys (Checkout Session id, subscription id, …). */
  claimIds: string[];
  /** Ids that may point at the original payment of a refund. */
  refundOf: string[];
  /** A subscription's billing cycle charge (not its first invoice), even for a customer Minilytics never saw pay. */
  renewal?: boolean;
}

export interface StripeClaim {
  paymentId: string;
  visitorId: string;
}

export interface StripeParseResult {
  payments: StripePaymentDraft[];
  claims: StripeClaim[];
}

const EMPTY: StripeParseResult = { payments: [], claims: [] };

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Stripe ids arrive as a string or as an expanded `{ id }` object. */
function idOf(v: unknown): string | null {
  const direct = str(v);
  if (direct) return direct;
  return str(asRecord(v).id);
}

function pickMeta(meta: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const value = str(meta[k]);
    if (value) return value;
  }
  return null;
}

/** Later objects win. Empty strings are ignored so they don't wipe a real value. */
function mergeMeta(...metas: Record<string, unknown>[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const meta of metas) {
    for (const [k, v] of Object.entries(meta)) if (str(v)) out[k] = v;
  }
  return out;
}

function secs(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 1000) : fallback;
}

function currencyOf(v: unknown, fallback: string): string {
  return (str(v) ?? fallback).toUpperCase();
}

function uniq(ids: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function dedupeDrafts(drafts: StripePaymentDraft[]): StripePaymentDraft[] {
  const seen = new Set<string>();
  const out: StripePaymentDraft[] = [];
  for (const draft of drafts) {
    if (seen.has(draft.id)) continue;
    seen.add(draft.id);
    out.push(draft);
  }
  return out;
}

function claimsFor(visitorId: string | null, ids: (string | null | undefined)[]): StripeClaim[] {
  if (!visitorId) return [];
  return uniq(ids).map((paymentId) => ({ paymentId, visitorId }));
}

function draftPayment(p: Omit<StripePaymentDraft, 'kind' | 'refundOf'> & { refundOf?: string[] }): StripePaymentDraft {
  return { kind: 'payment', refundOf: p.refundOf ?? [], ...p };
}

function parseCheckout(obj: Record<string, unknown>, eventCreated: number, currencyFallback: string, forcePaid: boolean): StripeParseResult {
  const mode = str(obj.mode);
  if (mode !== 'payment' && mode !== 'subscription') return EMPTY;

  const details = asRecord(obj.customer_details);
  const subscription = asRecord(obj.subscription);
  const meta = mergeMeta(asRecord(subscription.metadata), asRecord(obj.metadata));
  const clientRef = str(obj.client_reference_id);
  const visitorId = pickMeta(meta, VISITOR_KEYS) ?? clientRef;
  const sessionId = pickMeta(meta, SESSION_KEYS);
  const email = str(details.email)?.toLowerCase() ?? str(obj.customer_email)?.toLowerCase() ?? null;
  const name = str(details.name);
  const customerId = idOf(obj.customer);
  const invoiceId = idOf(obj.invoice);
  const paymentIntentId = idOf(obj.payment_intent);
  const subscriptionId = idOf(obj.subscription);
  const checkoutSessionId = str(obj.id);
  const amount = Number(obj.amount_total) || 0;
  const paid = forcePaid || obj.payment_status === 'paid';
  const ts = secs(obj.created, secs(eventCreated, Date.now()));
  const currency = currencyOf(obj.currency, currencyFallback);
  const claims = claimsFor(visitorId, [invoiceId, subscriptionId, checkoutSessionId, paymentIntentId]);

  // Subscription money is keyed by the invoice id so `invoice.paid` (first charge and the
  // same checkout, if it arrives too) is the same row. Without an invoice id, wait for invoice.paid.
  const id = mode === 'subscription' ? invoiceId : paymentIntentId ?? checkoutSessionId;
  if (!paid || amount <= 0 || !id) return { payments: [], claims };

  return {
    claims,
    payments: [
      draftPayment({
        id,
        ts,
        amount,
        currency,
        visitorId,
        sessionId,
        customerId,
        email,
        name,
        subscriptionId,
        paymentIntentId,
        checkoutSessionId,
        claimIds: uniq([checkoutSessionId, invoiceId, subscriptionId, paymentIntentId]),
      }),
    ],
  };
}

function subscriptionOf(invoice: Record<string, unknown>): { id: string | null; metadata: Record<string, unknown> } {
  // API 2025-03-31 (basil) moved subscription onto parent.subscription_details.
  // Older webhook endpoints still send invoice.subscription and invoice.subscription_details.
  const parent = asRecord(invoice.parent);
  const fromParent = asRecord(parent.subscription_details);
  const legacy = asRecord(invoice.subscription_details);
  const id = idOf(fromParent.subscription) ?? idOf(invoice.subscription) ?? idOf(legacy.subscription);
  const metadata = mergeMeta(asRecord(legacy.metadata), asRecord(fromParent.metadata));
  return { id, metadata };
}

function lineMetadata(invoice: Record<string, unknown>): Record<string, unknown> {
  const lines = asRecord(invoice.lines);
  const merged: Record<string, unknown> = {};
  for (const line of asArray(lines.data)) Object.assign(merged, asRecord(asRecord(line).metadata));
  return merged;
}

function paymentIntentOfInvoice(invoice: Record<string, unknown>): string | null {
  const direct = idOf(invoice.payment_intent);
  if (direct) return direct;
  const payments = asRecord(invoice.payments);
  for (const entry of asArray(payments.data)) {
    const payment = asRecord(asRecord(entry).payment);
    const pi = idOf(payment.payment_intent);
    if (pi) return pi;
  }
  return null;
}

function parseInvoice(obj: Record<string, unknown>, eventCreated: number, currencyFallback: string, eventType: string): StripeParseResult {
  const sub = subscriptionOf(obj);
  const reason = str(obj.billing_reason);
  const isSubscription =
    !!sub.id || str(asRecord(obj.parent).type) === 'subscription_details' || (reason !== null && SUBSCRIPTION_REASONS.has(reason));
  // One-off invoices are recorded from the Checkout Session (payment intent id). Recording them
  // again here would double-count a Checkout that also creates an invoice.
  if (!isSubscription) return EMPTY;

  const status = str(obj.status);
  const paid = eventType === 'invoice.paid' || status === 'paid' || obj.paid === true;
  if (!paid || (status !== null && status !== 'paid')) return EMPTY;

  const amount = Number(obj.amount_paid) || 0;
  const id = str(obj.id);
  if (amount <= 0 || !id) return EMPTY;

  const meta = mergeMeta(lineMetadata(obj), sub.metadata, asRecord(obj.metadata));
  const paymentIntentId = paymentIntentOfInvoice(obj);
  const transitions = asRecord(obj.status_transitions);
  return {
    claims: [],
    payments: [
      draftPayment({
        id,
        ts: secs(transitions.paid_at, secs(obj.created, secs(eventCreated, Date.now()))),
        amount,
        currency: currencyOf(obj.currency, currencyFallback),
        visitorId: pickMeta(meta, VISITOR_KEYS),
        sessionId: pickMeta(meta, SESSION_KEYS),
        customerId: idOf(obj.customer),
        email: str(obj.customer_email)?.toLowerCase() ?? null,
        name: str(obj.customer_name),
        subscriptionId: sub.id,
        paymentIntentId,
        checkoutSessionId: null,
        claimIds: uniq([id, sub.id, paymentIntentId]),
        renewal: reason === 'subscription_cycle',
      }),
    ],
  };
}

function parseRefund(
  refund: Record<string, unknown>,
  charge: Record<string, unknown> | null,
  eventCreated: number,
  currencyFallback: string,
): StripePaymentDraft | null {
  const status = str(refund.status);
  if (status && status !== 'succeeded') return null;
  const id = str(refund.id);
  const amount = Number(refund.amount) || 0;
  if (!id || amount <= 0) return null;
  const paymentIntentId = idOf(refund.payment_intent) ?? (charge ? idOf(charge.payment_intent) : null);
  const chargeId = idOf(refund.charge) ?? (charge ? str(charge.id) : null);
  const invoiceId = charge ? idOf(charge.invoice) : null;
  const billing = charge ? asRecord(charge.billing_details) : {};
  const meta = mergeMeta(charge ? asRecord(charge.metadata) : {}, asRecord(refund.metadata));
  return {
    id,
    kind: 'refund',
    ts: secs(refund.created, secs(eventCreated, Date.now())),
    amount: -Math.abs(Math.round(amount)),
    currency: currencyOf(refund.currency ?? charge?.currency, currencyFallback),
    visitorId: pickMeta(meta, VISITOR_KEYS),
    sessionId: pickMeta(meta, SESSION_KEYS),
    customerId: (charge ? idOf(charge.customer) : null) ?? idOf(refund.customer),
    email: str(billing.email)?.toLowerCase() ?? null,
    name: str(billing.name),
    subscriptionId: null,
    paymentIntentId,
    checkoutSessionId: null,
    claimIds: [],
    refundOf: uniq([paymentIntentId, chargeId, invoiceId]),
  };
}

function parseChargeRefunded(obj: Record<string, unknown>, eventCreated: number, currencyFallback: string): StripeParseResult {
  const refunds = asArray(asRecord(obj.refunds).data)
    .map((refund) => parseRefund(asRecord(refund), obj, eventCreated, currencyFallback))
    .filter((refund): refund is StripePaymentDraft => !!refund);
  if (refunds.length) return { payments: refunds, claims: [] };

  const amount = Number(obj.amount_refunded) || 0;
  const chargeId = str(obj.id);
  if (amount <= 0 || !chargeId) return EMPTY;
  const paymentIntentId = idOf(obj.payment_intent);
  const invoiceId = idOf(obj.invoice);
  const billing = asRecord(obj.billing_details);
  const meta = asRecord(obj.metadata);
  return {
    claims: [],
    payments: [
      {
        id: `refund_total_${chargeId}`,
        kind: 'refund',
        ts: secs(eventCreated, Date.now()),
        amount: -Math.abs(Math.round(amount)),
        currency: currencyOf(obj.currency, currencyFallback),
        visitorId: pickMeta(meta, VISITOR_KEYS),
        sessionId: pickMeta(meta, SESSION_KEYS),
        customerId: idOf(obj.customer),
        email: str(billing.email)?.toLowerCase() ?? null,
        name: str(billing.name),
        subscriptionId: null,
        paymentIntentId,
        checkoutSessionId: null,
        claimIds: [],
        refundOf: uniq([paymentIntentId, chargeId, invoiceId]),
      },
    ],
  };
}

/** Turn one Stripe Event into the payments to store and the visitor claims to remember. */
export function paymentsFromStripeEvent(event: unknown, currencyFallback = 'USD'): StripeParseResult {
  const root = asRecord(event);
  const type = str(root.type);
  const obj = asRecord(asRecord(root.data).object);
  if (!type || !Object.keys(obj).length) return EMPTY;
  const created = typeof root.created === 'number' ? root.created : 0;
  switch (type) {
    case 'checkout.session.completed':
      return parseCheckout(obj, created, currencyFallback, false);
    case 'checkout.session.async_payment_succeeded':
      return parseCheckout(obj, created, currencyFallback, true);
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      return parseInvoice(obj, created, currencyFallback, type);
    case 'charge.refunded':
      return parseChargeRefunded(obj, created, currencyFallback);
    case 'refund.created':
    case 'refund.updated': {
      const refund = parseRefund(obj, null, created, currencyFallback);
      return refund ? { payments: [refund], claims: [] } : EMPTY;
    }
    default:
      return EMPTY;
  }
}

interface OriginalPayment {
  visitor_id: string | null;
  session_id: string | null;
  currency: string;
  customer_id: string | null;
  email: string | null;
  name: string | null;
}

async function findOriginal(db: D1Database, siteId: string, keys: string[]): Promise<OriginalPayment | null> {
  const unique = uniq(keys);
  if (!unique.length) return null;
  const ph = unique.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT visitor_id, session_id, currency, customer_id, email, name
       FROM payments WHERE site_id = ? AND kind = 'payment'
         AND (id IN (${ph}) OR IFNULL(payment_intent_id, '') IN (${ph})
              OR IFNULL(checkout_session_id, '') IN (${ph}) OR IFNULL(subscription_id, '') IN (${ph}))
       ORDER BY ts ASC LIMIT 1`,
    )
    .bind(siteId, ...unique, ...unique, ...unique, ...unique)
    .first<OriginalPayment>();
}

async function recordStripeRefund(db: D1Database, site: Site, draft: StripePaymentDraft) {
  const original = await findOriginal(db, site.id, draft.refundOf);
  const visitorId = original?.visitor_id ?? draft.visitorId;
  const sessionId = original?.session_id ?? draft.sessionId;
  const customerId = original?.customer_id ?? draft.customerId;
  const email = original?.email ?? draft.email;
  const name = original?.name ?? draft.name;
  if (original) {
    await db
      .prepare(
        `INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id, customer_id, email, name)
         VALUES (?, ?, 'stripe', ?, ?, 'refund', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           amount = excluded.amount,
           ts = excluded.ts,
           visitor_id = COALESCE(payments.visitor_id, excluded.visitor_id),
           session_id = COALESCE(payments.session_id, excluded.session_id),
           customer_id = COALESCE(payments.customer_id, excluded.customer_id),
           email = COALESCE(payments.email, excluded.email),
           name = COALESCE(payments.name, excluded.name)
         WHERE payments.kind = 'refund' AND payments.provider = 'stripe'
           AND ABS(excluded.amount) >= ABS(payments.amount)`,
      )
      .bind(
        draft.id,
        site.id,
        draft.ts,
        draft.amount,
        (draft.currency || original.currency || site.currency).toUpperCase(),
        visitorId,
        sessionId,
        customerId,
        email,
        name,
      )
      .run();
    return;
  }
  // No original row yet (or it was keyed by an id this refund doesn't carry): attribute like any other payment.
  await recordPayment(db, site, {
    id: draft.id,
    provider: 'stripe',
    ts: draft.ts,
    amount: draft.amount,
    kind: 'refund',
    currency: draft.currency || site.currency,
    visitorId: draft.visitorId,
    sessionId: draft.sessionId,
    customerId: draft.customerId,
    email: draft.email,
    name: draft.name,
    paymentIntentId: draft.paymentIntentId,
    claimIds: draft.refundOf,
  });
}

/** Stripe webhook: POST /api/webhooks/stripe/:siteId */
export async function handleStripeWebhook(c: Context<AppEnv>) {
  const site = await getSite(c.env.DB, c.req.param('siteId')!);
  if (!site) return c.json({ error: 'unknown site' }, 404);
  if (!site.stripe_webhook_secret) return c.json({ error: 'webhook secret not configured for this site' }, 400);

  const body = await c.req.text();
  const ok = await verifyStripeWebhook(site.stripe_webhook_secret, c.req.header('stripe-signature') ?? null, body);
  if (!ok) return c.json({ error: 'invalid signature' }, 401);

  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }

  const parsed = paymentsFromStripeEvent(event, site.currency);
  const db = c.env.DB;
  if (parsed.claims.length) {
    const now = Date.now();
    // The checkout may carry the id of a visitor that has since been merged into another one.
    const claims = await Promise.all(
      parsed.claims.map(async (claim) => ({ ...claim, visitorId: await resolveVisitor(db, site.id, claim.visitorId) })),
    );
    // Remember the visitor against every id this checkout mentioned, and link a payment that
    // arrived earlier without metadata (a trial's first paid invoice, for example).
    await db.batch([
      ...claims.map((claim) =>
        db
          .prepare('INSERT OR IGNORE INTO payment_claims (site_id, payment_id, visitor_id, ts) VALUES (?, ?, ?, ?)')
          .bind(site.id, claim.paymentId, claim.visitorId, now),
      ),
      ...claims.map((claim) =>
        db
          .prepare(
            `UPDATE payments SET visitor_id = ?, matched_by = COALESCE(matched_by, 'metadata'),
               session_id = COALESCE(session_id, (${creditedSessionSql()}))
             WHERE site_id = ? AND visitor_id IS NULL AND kind = 'payment'
               AND (id = ? OR subscription_id = ? OR IFNULL(payment_intent_id, '') = ? OR IFNULL(checkout_session_id, '') = ?)`,
          )
          .bind(claim.visitorId, site.id, claim.visitorId, now + 60_000, site.id, claim.paymentId, claim.paymentId, claim.paymentId, claim.paymentId),
      ),
    ]);
  }

  for (const draft of dedupeDrafts(parsed.payments)) {
    if (draft.kind === 'refund') {
      await recordStripeRefund(db, site, draft);
      continue;
    }
    await recordPayment(db, site, {
      id: draft.id,
      provider: 'stripe',
      ts: draft.ts,
      amount: draft.amount,
      kind: 'payment',
      currency: draft.currency || site.currency,
      visitorId: draft.visitorId,
      sessionId: draft.sessionId,
      customerId: draft.customerId,
      email: draft.email,
      name: draft.name,
      subscriptionId: draft.subscriptionId,
      paymentIntentId: draft.paymentIntentId,
      checkoutSessionId: draft.checkoutSessionId,
      claimIds: draft.claimIds,
      renewal: draft.renewal,
    });
  }
  return c.json({ ok: true });
}
