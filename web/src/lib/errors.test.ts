// The point of this function is that three different failures must not render
// as the same sentence. Before it, every query error collapsed into 发生错误.

import { describe, expect, it } from 'vitest';
import { ApiError, ContractViolation } from '@pontis/api';
import { authFieldError, describeError } from './errors';

describe('describeError', () => {
  it('keeps the server code on a client-side rejection', () => {
    const error = new ApiError(404, 'SPACE_NOT_FOUND', 'unknown space', 'req_1');
    expect(describeError(error)).toBe('[SPACE_NOT_FOUND] unknown space');
  });

  it('names the request for a 5xx, because that is the only way to find it', () => {
    // The client only ever gets a generic "internal error" from the server; the
    // request id is what ties it to a line in the server log.
    const text = describeError(new ApiError(500, 'INTERNAL', 'internal error', 'req_7f3'));
    expect(text).toContain('req_7f3');
    expect(text).toContain('INTERNAL');
  });

  it('passes a contract violation through unchanged', () => {
    const error = new ContractViolation('body.nodes[0].position', 'a number', '0');
    expect(describeError(error)).toBe(
      'API contract violated at body.nodes[0].position: expected a number, received "0"',
    );
  });

  it('says something for a request that never arrived, and nothing for no error', () => {
    expect(describeError(new TypeError('Failed to fetch'))).toBe('Failed to fetch');
    expect(describeError(undefined)).toBeUndefined();
    expect(describeError(null)).toBeUndefined();
    expect(describeError('a string')).toBeUndefined();
    expect(describeError(new Error(''))).toBeUndefined();
  });
});

// What a rejected sign-up is told, and where. The four codes the server uses to
// name one half of the form must land under that field; the rest stay with the
// form, because they are not about any one box.
describe('authFieldError', () => {
  it('routes a rejected field to the box it rejected', () => {
    const taken = new ApiError(409, 'USERNAME_TAKEN', 'username already in use', 'req_1');
    expect(authFieldError(taken)).toEqual({ field: 'username', text: '这个用户名已经被占用' });
    expect(authFieldError(new ApiError(400, 'INVALID_PASSWORD', 'password must be at least 8 characters', 'r'))).toEqual({
      field: 'password',
      text: '密码至少 8 个字符',
    });
    expect(authFieldError(new ApiError(409, 'EMAIL_TAKEN', 'email already in use', 'r'))?.field).toBe('email');
  });

  it('leaves a wrong credential with the form, because saying which half was wrong leaks who exists', () => {
    expect(authFieldError(new ApiError(401, 'INVALID_CREDENTIALS', 'unknown user or wrong password', 'r'))).toBeNull();
    expect(authFieldError(new ApiError(403, 'RESET_TOKEN_INVALID', 'reset link is invalid, used or expired', 'r'))).toBeNull();
    expect(authFieldError(new ApiError(500, 'INTERNAL', 'internal error', 'r'))).toBeNull();
  });

  it('says nothing for a failure that never reached the server', () => {
    expect(authFieldError(new TypeError('Failed to fetch'))).toBeNull();
    expect(authFieldError(undefined)).toBeNull();
    expect(authFieldError(null)).toBeNull();
  });
});
