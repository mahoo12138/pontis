import { describe, expect, it } from 'vitest';
import { errText } from './runtime';
import { ApiError } from '../core/transport/client';

describe('errText', () => {
  it('keeps the code a person would quote back', () => {
    expect(errText({ code: 'SPACE_NOT_FOUND', message: 'no such space' })).toBe('SPACE_NOT_FOUND: no such space');
  });

  it('does not print the code twice when the error already spells it', () => {
    // ApiError builds its message as `${code}: ${message}`, so a second prefix
    // read like "DEVICE_CREDENTIAL_INVALID: DEVICE_CREDENTIAL_INVALID: …".
    expect(errText(new ApiError(401, 'DEVICE_CREDENTIAL_INVALID', 'invalid device credential'))).toBe(
      'DEVICE_CREDENTIAL_INVALID: invalid device credential',
    );
  });

  it('falls back to the value when there is nothing structured to read', () => {
    expect(errText('boom')).toBe('boom');
    expect(errText(new Error('plain'))).toBe('plain');
  });
});
