import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyStripeWebhook } from '../src/worker/lib/crypto';
import { dedupeDrafts, paymentsFromStripeEvent, type StripePaymentDraft } from '../src/worker/stripe';

const SECRET = 'whsec_test_secret_value';

function sign(body: string, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const sig = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return { timestamp, header: `t=${timestamp},v1=${sig}` };
}

describe('Stripe webhook signatures', () => {
  const body = '{"id":"evt_1","type":"invoice.paid"}';
  const { timestamp, header } = sign(body);

  it('accepts a valid signature, including a second v1 during secret rotation', async () => {
    expect(await verifyStripeWebhook(SECRET, header, body)).toBe(true);
    expect(await verifyStripeWebhook(SECRET, `t=${timestamp},v1=${'ab'.repeat(32)},v1=${header.split('v1=')[1]}`, body)).toBe(true);
    expect(await verifyStripeWebhook(SECRET, header.toUpperCase().replace('T=', 't=').replace('V1=', 'v1='), body)).toBe(true);
  });

  it('uses the raw whsec_ secret, not the base64 payload after the prefix', async () => {
    const raw = Buffer.from('super-secret-key-bytes');
    const secret = 'whsec_' + raw.toString('base64');
    const ts = String(timestamp);
    const good = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
    const dodoStyle = createHmac('sha256', raw).update(`${ts}.${body}`).digest('hex');
    expect(await verifyStripeWebhook(secret, `t=${ts},v1=${good}`, body)).toBe(true);
    expect(await verifyStripeWebhook(secret, `t=${ts},v1=${dodoStyle}`, body)).toBe(false);
  });

  it('rejects a tampered body, a stale timestamp and a missing header', async () => {
    expect(await verifyStripeWebhook(SECRET, header, body + ' ')).toBe(false);
    expect(await verifyStripeWebhook(SECRET, header, body, (timestamp + 301) * 1000)).toBe(false);
    expect(await verifyStripeWebhook(SECRET, header, body, (timestamp - 301) * 1000)).toBe(false);
    expect(await verifyStripeWebhook(SECRET, header, body, (timestamp + 300) * 1000)).toBe(true);
    expect(await verifyStripeWebhook(SECRET, null, body)).toBe(false);
    expect(await verifyStripeWebhook('', header, body)).toBe(false);
  });
});

const checkoutSubscription = {
  id: 'evt_cs',
  type: 'checkout.session.completed',
  created: 1_700_000_000,
  data: {
    object: {
      id: 'cs_test_123',
      object: 'checkout.session',
      mode: 'subscription',
      payment_status: 'paid',
      amount_total: 2900,
      currency: 'eur',
      client_reference_id: 'vis_from_ref',
      customer: 'cus_1',
      customer_details: { email: 'Jane@Elyx.ai', name: 'Jane' },
      metadata: { ml_visitor_id: 'vis_1', ml_session_id: 'ses_1' },
      payment_intent: 'pi_1',
      invoice: 'in_1',
      subscription: 'sub_1',
      created: 1_700_000_000,
    },
  },
};

const invoicePaid = {
  id: 'evt_in',
  type: 'invoice.paid',
  created: 1_700_000_100,
  data: {
    object: {
      id: 'in_1',
      object: 'invoice',
      status: 'paid',
      amount_paid: 2900,
      currency: 'eur',
      billing_reason: 'subscription_create',
      customer: { id: 'cus_1' },
      customer_email: 'jane@elyx.ai',
      customer_name: 'Jane',
      parent: {
        type: 'subscription_details',
        subscription_details: {
          subscription: 'sub_1',
          metadata: { ml_visitor_id: 'vis_1', ml_session_id: 'ses_1' },
        },
      },
      payments: { data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_1' } }] },
      status_transitions: { paid_at: 1_700_000_100 },
    },
  },
};

function pay(event: unknown): StripePaymentDraft[] {
  return paymentsFromStripeEvent(event, 'EUR').payments;
}

describe('Stripe event parsing', () => {
  it('records a one-off Checkout payment from the payment intent, metadata and client_reference_id', () => {
    const [row] = pay({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_one',
          mode: 'payment',
          payment_status: 'paid',
          amount_total: 4900,
          currency: 'eur',
          metadata: { ml_session_id: 'ses_one' },
          client_reference_id: 'vis_client',
          payment_intent: { id: 'pi_one' },
          customer: 'cus_one',
          customer_details: { email: 'Ann@Example.com', name: 'Ann' },
          created: 1_700_000_200,
        },
      },
    });
    expect(row).toMatchObject({
      id: 'pi_one',
      kind: 'payment',
      amount: 4900,
      currency: 'EUR',
      visitorId: 'vis_client',
      sessionId: 'ses_one',
      email: 'ann@example.com',
      name: 'Ann',
      customerId: 'cus_one',
      checkoutSessionId: 'cs_one',
      paymentIntentId: 'pi_one',
      ts: 1_700_000_200_000,
    });
    expect(row.claimIds).toContain('cs_one');
  });

  it('prefers metadata over client_reference_id and ignores unpaid or setup sessions', () => {
    const [row] = pay({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_meta',
          mode: 'payment',
          payment_status: 'paid',
          amount_total: 100,
          currency: 'usd',
          metadata: { ml_visitor_id: 'from_meta' },
          client_reference_id: 'from_ref',
          payment_intent: 'pi_meta',
        },
      },
    });
    expect(row.visitorId).toBe('from_meta');
    expect(pay({ type: 'checkout.session.completed', data: { object: { id: 'cs_u', mode: 'payment', payment_status: 'unpaid', amount_total: 100, payment_intent: 'pi_u' } } })).toEqual([]);
    expect(pay({ type: 'checkout.session.completed', data: { object: { id: 'cs_s', mode: 'setup', payment_status: 'no_payment_required', amount_total: 0 } } })).toEqual([]);
  });

  it('treats a delayed Checkout success as paid', () => {
    const [row] = pay({
      type: 'checkout.session.async_payment_succeeded',
      data: {
        object: { id: 'cs_async', mode: 'payment', payment_status: 'unpaid', amount_total: 1500, currency: 'eur', payment_intent: 'pi_async', metadata: { ml_visitor_id: 'vis_async' } },
      },
    });
    expect(row).toMatchObject({ id: 'pi_async', amount: 1500, visitorId: 'vis_async' });
  });

  it('keys a paid subscription checkout and invoice.paid to the same invoice id', () => {
    const fromCheckout = paymentsFromStripeEvent(checkoutSubscription);
    const fromInvoice = paymentsFromStripeEvent(invoicePaid);
    expect(fromCheckout.payments).toHaveLength(1);
    expect(fromInvoice.payments).toHaveLength(1);
    expect(fromCheckout.payments[0].id).toBe('in_1');
    expect(fromInvoice.payments[0].id).toBe(fromCheckout.payments[0].id);
    expect(fromCheckout.payments[0]).toMatchObject({
      amount: 2900,
      currency: 'EUR',
      visitorId: 'vis_1',
      sessionId: 'ses_1',
      email: 'jane@elyx.ai',
      subscriptionId: 'sub_1',
      paymentIntentId: 'pi_1',
      checkoutSessionId: 'cs_test_123',
    });
    expect(fromInvoice.payments[0]).toMatchObject({
      amount: 2900,
      visitorId: 'vis_1',
      sessionId: 'ses_1',
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      paymentIntentId: 'pi_1',
      ts: 1_700_000_100_000,
    });
    expect(fromCheckout.claims.map((c) => c.paymentId).sort()).toEqual(['cs_test_123', 'in_1', 'pi_1', 'sub_1']);
  });

  it('does not store a zero-amount trial checkout, but remembers the visitor for the later invoice', () => {
    const parsed = paymentsFromStripeEvent({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_trial',
          mode: 'subscription',
          payment_status: 'no_payment_required',
          amount_total: 0,
          currency: 'eur',
          subscription: 'sub_trial',
          metadata: { ml_visitor_id: 'vis_trial' },
        },
      },
    });
    expect(parsed.payments).toEqual([]);
    expect(parsed.claims).toContainEqual({ paymentId: 'sub_trial', visitorId: 'vis_trial' });
  });

  it('parses a legacy invoice and a renewal as separate payments, and skips one-off invoices', () => {
    const legacy = pay({
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          id: 'in_legacy',
          status: 'paid',
          paid: true,
          amount_paid: 1000,
          currency: 'usd',
          billing_reason: 'subscription_cycle',
          subscription: 'sub_9',
          subscription_details: { metadata: { visitor_id: 'vis_9' } },
          payment_intent: 'pi_9',
          customer_email: 'a@b.co',
          created: 1_700_000_300,
        },
      },
    })[0];
    expect(legacy).toMatchObject({ id: 'in_legacy', amount: 1000, currency: 'USD', visitorId: 'vis_9', subscriptionId: 'sub_9', paymentIntentId: 'pi_9' });

    const renewal = pay({
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_2',
          status: 'paid',
          amount_paid: 2900,
          currency: 'eur',
          billing_reason: 'subscription_cycle',
          customer: 'cus_1',
          parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1', metadata: { ml_visitor_id: 'vis_1', ml_session_id: 'ses_1' } } },
        },
      },
    })[0];
    expect(renewal.id).toBe('in_2');
    expect(renewal.id).not.toBe(pay(invoicePaid)[0].id);
    expect(renewal.visitorId).toBe('vis_1');

    expect(
      pay({
        type: 'invoice.paid',
        data: { object: { id: 'in_manual', status: 'paid', amount_paid: 4900, currency: 'eur', billing_reason: 'manual', payment_intent: 'pi_one' } },
      }),
    ).toEqual([]);
    expect(pay({ type: 'invoice.paid', data: { object: { id: 'in_trial', status: 'paid', amount_paid: 0, currency: 'eur', billing_reason: 'subscription_create', subscription: 'sub_t' } } })).toEqual([]);
    expect(pay({ type: 'invoice.paid', data: { object: { id: 'in_open', status: 'open', amount_paid: 500, currency: 'eur', billing_reason: 'subscription_cycle', subscription: 'sub_x' } } })).toEqual([]);
  });

  it('reads visitor ids copied onto invoice line metadata', () => {
    const [row] = pay({
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_line',
          status: 'paid',
          amount_paid: 2000,
          currency: 'eur',
          billing_reason: 'subscription_create',
          subscription: 'sub_line',
          lines: { data: [{ metadata: { minilytics_visitor_id: 'vis_line', minilytics_session_id: 'ses_line' } }] },
        },
      },
    });
    expect(row.visitorId).toBe('vis_line');
    expect(row.sessionId).toBe('ses_line');
  });

  it('ignores unknown events and malformed payloads', () => {
    expect(paymentsFromStripeEvent(null)).toEqual({ payments: [], claims: [] });
    expect(paymentsFromStripeEvent({ type: 'customer.created', data: { object: { id: 'cus_1' } } })).toEqual({ payments: [], claims: [] });
    expect(paymentsFromStripeEvent({ type: 'invoice.paid' })).toEqual({ payments: [], claims: [] });
  });
});

describe('Stripe refunds and dedup', () => {
  const charge = {
    id: 'evt_ch',
    type: 'charge.refunded',
    created: 1_700_000_400,
    data: {
      object: {
        id: 'ch_1',
        object: 'charge',
        amount: 2900,
        amount_refunded: 1500,
        currency: 'eur',
        payment_intent: 'pi_1',
        invoice: 'in_1',
        customer: 'cus_1',
        billing_details: { email: 'Jane@Elyx.ai', name: 'Jane' },
        refunds: {
          data: [
            { id: 're_a', amount: 1000, currency: 'eur', status: 'succeeded', payment_intent: 'pi_1', charge: 'ch_1', created: 1_700_000_400 },
            { id: 're_b', amount: 500, currency: 'eur', status: 'succeeded', payment_intent: 'pi_1', charge: 'ch_1', created: 1_700_000_500 },
            { id: 're_pending', amount: 200, currency: 'eur', status: 'pending', payment_intent: 'pi_1', charge: 'ch_1' },
          ],
        },
      },
    },
  };

  it('records each succeeded refund once, with a negative amount, and links it to the original ids', () => {
    const refunds = pay(charge);
    expect(refunds.map((r) => [r.id, r.amount, r.kind])).toEqual([
      ['re_a', -1000, 'refund'],
      ['re_b', -500, 'refund'],
    ]);
    expect(refunds[0]).toMatchObject({ currency: 'EUR', email: 'jane@elyx.ai', customerId: 'cus_1', paymentIntentId: 'pi_1' });
    expect(refunds[0].refundOf).toEqual(expect.arrayContaining(['pi_1', 'ch_1', 'in_1']));
    expect(pay(charge).map((r) => r.id)).toEqual(refunds.map((r) => r.id));
  });

  it('falls back to one cumulative row when the charge has no refund list', () => {
    const [row] = pay({
      type: 'charge.refunded',
      created: 1_700_000_600,
      data: { object: { id: 'ch_bare', amount_refunded: 2900, currency: 'usd', payment_intent: 'pi_bare' } },
    });
    expect(row).toMatchObject({ id: 'refund_total_ch_bare', amount: -2900, currency: 'USD', paymentIntentId: 'pi_bare' });
    expect(pay({ type: 'charge.refunded', data: { object: { id: 'ch_bare', amount_refunded: 2900, currency: 'usd', payment_intent: 'pi_bare' } } })[0].id).toBe(row.id);
  });

  it('accepts refund.updated only once it has succeeded', () => {
    expect(pay({ type: 'refund.created', data: { object: { id: 're_wait', amount: 400, currency: 'eur', status: 'pending', payment_intent: 'pi_1' } } })).toEqual([]);
    const [row] = pay({
      type: 'refund.updated',
      data: { object: { id: 're_wait', amount: 400, currency: 'eur', status: 'succeeded', payment_intent: 'pi_1', charge: 'ch_1', created: 1_700_000_700 } },
    });
    expect(row).toMatchObject({ id: 're_wait', amount: -400, kind: 'refund' });
    expect(row.refundOf).toEqual(expect.arrayContaining(['pi_1', 'ch_1']));
  });

  it('collapses checkout + invoice.paid + a Stripe retry into a single payment, and keeps partial refunds distinct', () => {
    const stored = new Map<string, StripePaymentDraft>();
    for (const event of [checkoutSubscription, invoicePaid, invoicePaid, charge, charge]) {
      for (const draft of dedupeDrafts(pay(event))) {
        if (!stored.has(draft.id)) stored.set(draft.id, draft);
      }
    }
    const payments = [...stored.values()].filter((r) => r.kind === 'payment');
    const refunds = [...stored.values()].filter((r) => r.kind === 'refund');
    expect(payments.map((p) => p.id)).toEqual(['in_1']);
    expect(payments[0].amount).toBe(2900);
    expect(refunds.map((r) => r.id).sort()).toEqual(['re_a', 're_b']);
    expect(refunds.reduce((sum, r) => sum + r.amount, 0)).toBe(-1500);
    expect(dedupeDrafts([...refunds, ...refunds])).toHaveLength(2);
  });
});
