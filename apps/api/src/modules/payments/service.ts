import { randomBytes } from 'node:crypto';
import type { AppContext } from '../../context.js';
import type { AuthContext } from '../../auth/session.js';
import { withTransaction, type Db } from '../../db/pool.js';
import { sha256Hex } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { formatPayuAmount, payuRequestHash, PAYU_CHECKOUT_URL, verifyPayuResponse, type PayuResponse } from '../../lib/payu.js';
import { recordAudit } from '../audit/service.js';
import { ensureVisit } from '../visits/service.js';

type Scoped = AuthContext & { clinicId: string };

/** How long a payment link stays usable. Money that arrives after this is still recorded. */
const LINK_HOURS = 72;
const PRODUCT_INFO = 'Consultation fee';

export const PAYU_CALLBACK_PATH = '/api/payments/payu/callback';

function payuKeys(ctx: AppContext): { key: string; salt: string; env: 'test' | 'production' } {
  const { key, salt, env } = ctx.config.payu;
  if (!key || !salt) throw new AppError(409, 'payments_not_configured', 'Online payments are not set up yet');
  return { key, salt, env };
}

export interface PaymentLink {
  id: string;
  amount: number;
  payUrl: string;
  expiresAt: string;
}

/** Creates a payment link for whatever is still due on a visit. The link itself is the only thing the patient needs. */
export async function createPaymentLink(ctx: AppContext, auth: Scoped, tokenId: string): Promise<PaymentLink> {
  payuKeys(ctx);
  return withTransaction(ctx.pool, async (client) => {
    const visit = await ensureVisit(client, auth, tokenId);
    const { rows } = await client.query<{ fee_amount: number | null; amount_paid: number | null; phone_encrypted: string | null }>(
      `SELECT v.fee_amount, v.amount_paid, p.phone_encrypted
         FROM visits v JOIN patients p ON p.id = v.patient_id
        WHERE v.id = $1`,
      [visit.id],
    );
    const row = rows[0]!;
    const balance = (row.fee_amount ?? 0) - (row.amount_paid ?? 0);
    if (row.fee_amount === null || balance <= 0) {
      throw new AppError(409, 'nothing_due', 'Enter the fee first. There must be an amount still due.');
    }
    // PayU asks for a phone number on its page, so a patient without one cannot pay online.
    if (!row.phone_encrypted) throw new AppError(409, 'phone_required', 'Add the patient’s phone number before sending a payment link');

    const raw = randomBytes(32).toString('base64url');
    const txnid = `pr${randomBytes(10).toString('hex')}`;
    const expiresAt = new Date(ctx.now().getTime() + LINK_HOURS * 60 * 60 * 1000);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO payment_requests (clinic_id, visit_id, txnid, amount, token_hash, expires_at, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [auth.clinicId, visit.id, txnid, balance, sha256Hex(raw), expiresAt, auth.userId],
    );
    await recordAudit(client, {
      clinicId: auth.clinicId,
      actorUserId: auth.userId,
      action: 'payment.link_created',
      entityType: 'visit',
      entityId: visit.id,
      metadata: { amount: balance },
    });
    return {
      id: inserted.rows[0]!.id,
      amount: balance,
      payUrl: `${ctx.config.publicApiUrl}/api/public/pay/${raw}`,
      expiresAt: expiresAt.toISOString(),
    };
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a;margin:0;display:grid;place-items:center;min-height:100vh;padding:24px}
main{background:#fff;border-radius:16px;padding:28px;max-width:420px;width:100%;box-shadow:0 1px 3px rgba(0,0,0,.08);text-align:center}
h1{font-size:20px;margin:0 0 8px}p{color:#475569;line-height:1.6}button{background:#0f766e;color:#fff;border:0;border-radius:10px;padding:14px 20px;font-size:16px;cursor:pointer;width:100%}
.amount{font-size:32px;font-weight:600;margin:16px 0}</style></head><body><main>${body}</main></body></html>`;
}

/** The page behind a payment link. It shows the amount and sends the patient on to PayU. */
export async function renderPaymentPage(ctx: AppContext, rawToken: string): Promise<{ status: number; html: string }> {
  const keys = payuKeys(ctx);
  const { rows } = await ctx.pool.query<{
    txnid: string;
    amount: number;
    status: string;
    expires_at: Date;
    full_name: string;
    phone_encrypted: string | null;
    clinic_name: string;
    owner_email: string | null;
  }>(
    `SELECT pr.txnid, pr.amount, pr.status, pr.expires_at, p.full_name, p.phone_encrypted, c.name AS clinic_name,
            (SELECT u.email FROM users u WHERE u.clinic_id = pr.clinic_id AND u.role = 'owner' ORDER BY u.created_at LIMIT 1) AS owner_email
       FROM payment_requests pr
       JOIN visits v ON v.id = pr.visit_id
       JOIN patients p ON p.id = v.patient_id
       JOIN clinics c ON c.id = pr.clinic_id
      WHERE pr.token_hash = $1`,
    [sha256Hex(rawToken)],
  );
  const link = rows[0];
  if (!link) {
    return { status: 404, html: page('Link not found', '<h1>Link not found</h1><p>This payment link is not valid. Ask the clinic for a new one.</p>') };
  }
  if (link.status === 'paid') {
    return { status: 200, html: page('Already paid', '<h1>Already paid</h1><p>This amount has already been received. Thank you.</p>') };
  }
  if (link.status === 'failed' || link.expires_at.getTime() < ctx.now().getTime()) {
    return {
      status: 410,
      html: page('Link expired', '<h1>This link has expired</h1><p>Ask the clinic for a new payment link.</p>'),
    };
  }

  if (!link.phone_encrypted) {
    return { status: 409, html: page('Update needed', '<h1>Payment cannot start</h1><p>The clinic needs to add your phone number first. Please contact the clinic.</p>') };
  }

  const amount = formatPayuAmount(link.amount);
  const firstname = link.full_name.slice(0, 60);
  const email = link.owner_email ?? '';
  const phone = ctx.cipher.decrypt(link.phone_encrypted);
  const callback = `${ctx.config.publicApiUrl}${PAYU_CALLBACK_PATH}`;
  const hash = payuRequestHash({ key: keys.key, txnid: link.txnid, amount, productinfo: PRODUCT_INFO, firstname, email, salt: keys.salt });

  const fields: Record<string, string> = {
    key: keys.key,
    txnid: link.txnid,
    amount,
    productinfo: PRODUCT_INFO,
    firstname,
    email,
    phone,
    surl: callback,
    furl: callback,
    hash,
    service_provider: 'payu_paisa',
  };
  const inputs = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('');
  return {
    status: 200,
    html: page(
      `Pay ${link.clinic_name}`,
      `<h1>${escapeHtml(link.clinic_name)}</h1><p>${escapeHtml(PRODUCT_INFO)}</p><div class="amount">₹${escapeHtml(amount)}</div>
<form method="post" action="${PAYU_CHECKOUT_URL[keys.env]}">${inputs}<button type="submit">Continue to secure payment</button></form>
<p style="font-size:13px;margin-top:16px">Payment is processed by PayU. The clinic does not see your card details.</p>`,
    ),
  };
}

export type CallbackOutcome = 'paid' | 'failed' | 'duplicate' | 'unknown';

/**
 * PayU sends the result back to our callback URL. The reverse hash proves it came from PayU and that
 * the fields were not changed. Only a pending link can add money, so a repeated callback changes nothing.
 */
export async function handlePayuCallback(ctx: AppContext, fields: Record<string, string>): Promise<CallbackOutcome> {
  const { key, salt } = payuKeys(ctx);
  const response = fields as unknown as PayuResponse;
  if (typeof response.hash !== 'string' || response.key !== key || !verifyPayuResponse(response, salt)) {
    throw new AppError(400, 'invalid_hash', 'Payment response could not be verified');
  }

  return withTransaction(ctx.pool, async (client: Db) => {
    const { rows } = await client.query<{ id: string; visit_id: string; clinic_id: string; amount: number; status: string }>(
      'SELECT id, visit_id, clinic_id, amount, status FROM payment_requests WHERE txnid = $1 FOR UPDATE',
      [response.txnid],
    );
    const link = rows[0];
    if (!link) return 'unknown';
    if (link.status !== 'pending') return 'duplicate';

    if (response.status !== 'success') {
      await client.query(`UPDATE payment_requests SET status = 'failed' WHERE id = $1`, [link.id]);
      return 'failed';
    }
    if (Number(response.amount) !== link.amount) {
      throw new AppError(400, 'amount_mismatch', 'Payment amount does not match the link');
    }

    await client.query(
      `UPDATE payment_requests SET status = 'paid', gateway_payment_id = $2, paid_at = now() WHERE id = $1`,
      [link.id, response.mihpayid ?? null],
    );
    await client.query(
      `UPDATE visits SET amount_paid = COALESCE(amount_paid, 0) + $2, payment_method = 'online', updated_at = now() WHERE id = $1`,
      [link.visit_id, link.amount],
    );
    await recordAudit(client, {
      clinicId: link.clinic_id,
      actorUserId: null,
      action: 'payment.received',
      entityType: 'visit',
      entityId: link.visit_id,
      metadata: { amount: link.amount, provider: 'payu' },
    });
    return 'paid';
  });
}

export function callbackMessage(outcome: CallbackOutcome): { status: number; html: string } {
  switch (outcome) {
    case 'paid':
    case 'duplicate':
      return { status: 200, html: page('Payment received', '<h1>Payment received</h1><p>Thank you. You can close this page.</p>') };
    case 'failed':
      return { status: 200, html: page('Payment not completed', '<h1>Payment not completed</h1><p>No money was taken. You can try again from the clinic’s link.</p>') };
    case 'unknown':
      return { status: 404, html: page('Reference not found', '<h1>Reference not found</h1><p>Please contact the clinic with the time of your payment.</p>') };
  }
}

