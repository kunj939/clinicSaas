import { describe, expect, it } from 'vitest';
import { describeError } from '../../src/lib/errors.js';

describe('describeError', () => {
  it('uses the connection error codes when Node gives an AggregateError with no message', () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED ::1:5432'), { code: 'ECONNREFUSED' });
    const error = new AggregateError([inner, inner], '');
    expect(describeError(error)).toBe('AggregateError: ECONNREFUSED');
  });

  it('returns the message of a normal error and falls back to the name when the message is empty', () => {
    expect(describeError(new Error('Invalid configuration'))).toBe('Invalid configuration');
    expect(describeError(new TypeError(''))).toBe('TypeError');
  });

  it('stringifies non-error values', () => {
    expect(describeError('plain text')).toBe('plain text');
  });
});
