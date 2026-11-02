import { createHash } from 'node:crypto';
import { safeEqualStrings } from './crypto.js';

/**
 * PayU hosted checkout helpers. The formulas follow PayU's documented hash order:
 *   request:  key|txnid|amount|productinfo|firstname|email|udf1..udf10|salt   (10 empty udfs)
 *   response: salt|status|udf10..udf1|email|firstname|productinfo|amount|txnid|key
 * Hashes are SHA-512 in lowercase hex. They are the only thing that proves a callback came from PayU.
 */

export const PAYU_CHECKOUT_URL = {
  test: 'https://test.payu.in/_payment',
  production: 'https://secure.payu.in/_payment',
} as const;

const EMPTY_UDFS = '|||||||||||'; // ten empty udf fields plus the separator before the next value

function sha512(value: string): string {
  return createHash('sha512').update(value, 'utf8').digest('hex');
}

/** PayU wants amounts with two decimals, for example "500.00". */
export function formatPayuAmount(rupees: number): string {
  return rupees.toFixed(2);
}

export function payuRequestHash(input: {
  key: string;
  txnid: string;
  amount: string;
  productinfo: string;
  firstname: string;
  email: string;
  salt: string;
}): string {
  return sha512(`${input.key}|${input.txnid}|${input.amount}|${input.productinfo}|${input.firstname}|${input.email}${EMPTY_UDFS}${input.salt}`);
}

export interface PayuResponse {
  key: string;
  txnid: string;
  amount: string;
  productinfo: string;
  firstname: string;
  email: string;
  status: string;
  hash: string;
  mihpayid?: string;
}

/** True only when PayU's reverse hash matches the fields it sent back. */
export function verifyPayuResponse(response: PayuResponse, salt: string): boolean {
  const expected = sha512(
    `${salt}|${response.status}${EMPTY_UDFS}${response.email}|${response.firstname}|${response.productinfo}|${response.amount}|${response.txnid}|${response.key}`,
  );
  return safeEqualStrings(expected, response.hash.toLowerCase());
}
