import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { formatPayuAmount, payuRequestHash, verifyPayuResponse } from '../../src/lib/payu.js';

const sha512 = (value: string) => createHash('sha512').update(value, 'utf8').digest('hex');

describe('PayU hashes', () => {
  it('formats amounts with two decimals', () => {
    expect(formatPayuAmount(500)).toBe('500.00');
  });

  it('builds the request hash in PayU order, with ten empty udf fields before the salt', () => {
    const hash = payuRequestHash({
      key: 'KEY',
      txnid: 'TX1',
      amount: '500.00',
      productinfo: 'Consultation fee',
      firstname: 'Meena',
      email: 'clinic@example.com',
      salt: 'SALT',
    });
    // Written out literally so a change in the pipe count is caught here.
    expect(hash).toBe(sha512('KEY|TX1|500.00|Consultation fee|Meena|clinic@example.com|||||||||||SALT'));
    expect(hash).toMatch(/^[a-f0-9]{128}$/);
  });

  it('accepts a reverse hash that matches the response fields', () => {
    const response = {
      key: 'KEY',
      txnid: 'TX1',
      amount: '500.00',
      productinfo: 'Consultation fee',
      firstname: 'Meena',
      email: 'clinic@example.com',
      status: 'success',
      hash: sha512('SALT|success|||||||||||clinic@example.com|Meena|Consultation fee|500.00|TX1|KEY'),
    };
    expect(verifyPayuResponse(response, 'SALT')).toBe(true);
    expect(verifyPayuResponse({ ...response, hash: response.hash.toUpperCase() }, 'SALT')).toBe(true);
  });

  it('rejects a response whose amount was changed, or that was signed with another salt', () => {
    const hash = sha512('SALT|success|||||||||||clinic@example.com|Meena|Consultation fee|500.00|TX1|KEY');
    const base = { key: 'KEY', txnid: 'TX1', amount: '500.00', productinfo: 'Consultation fee', firstname: 'Meena', email: 'clinic@example.com', status: 'success', hash };
    expect(verifyPayuResponse({ ...base, amount: '5.00' }, 'SALT')).toBe(false);
    expect(verifyPayuResponse(base, 'OTHER-SALT')).toBe(false);
  });
});
