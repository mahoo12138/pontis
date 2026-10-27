// Turning a query failure into something an operator can act on.
//
// The UI used to render every failure as 发生错误, which made a broken API
// contract look exactly like a typo'd route or a dead server. The REST layer now
// throws named errors (ApiError carries the server's code, ContractViolation
// names the field that did not match), so discarding them throws away the one
// thing that distinguishes "the app and the server disagree" from "the request
// did not arrive".

import { ApiError, ContractViolation } from '@pontis/api';

/** Which box a rejected sign-up or password change belongs to.
 *
 *  The server names what it rejected by code, so the sentence can go under the
 *  field it is about instead of in a banner above the form, where it reads as a
 *  complaint about the page. The copy is written here rather than passed through:
 *  the server answers in English, and these four restate the form's own rules.
 *
 *  Codes that name no field stay with the form. `INVALID_CREDENTIALS` is
 *  deliberately not attributable — saying which half was wrong would tell someone
 *  which usernames exist — and a spent reset link is a fact about the link, not
 *  about a box.
 */
export type AuthField = 'username' | 'password' | 'email';

const AUTH_FIELD_ERRORS: Record<string, { field: AuthField; text: string }> = {
  INVALID_USERNAME: { field: 'username', text: '用户名需为 3–32 位字母、数字或 . _ -' },
  USERNAME_TAKEN: { field: 'username', text: '这个用户名已经被占用' },
  EMAIL_TAKEN: { field: 'email', text: '这个邮箱已经注册过了' },
  INVALID_PASSWORD: { field: 'password', text: '密码至少 8 个字符' },
};

export function authFieldError(error: unknown): { field: AuthField; text: string } | null {
  const code = (error as { code?: string } | null | undefined)?.code;
  return (code && AUTH_FIELD_ERRORS[code]) || null;
}

export function describeError(error: unknown): string | undefined {
  if (error instanceof ContractViolation) {
    // The message already names the path and what was expected, e.g.
    // `API contract violated at body.nodes[0].position: expected a number,
    // received "0"`. That is the operator-facing fact: this build and this
    // server do not agree.
    return error.message;
  }

  if (error instanceof ApiError) {
    // The server writes its own message; translating it here would invent text
    // the server never said. A 5xx only exists in the server log, so the
    // request id is the useful half.
    if (error.status >= 500) {
      return `[${error.code}] 服务端内部错误（请求号 ${error.requestId}，可在服务端日志中定位）`;
    }
    return `[${error.code}] ${error.message}`;
  }

  if (error instanceof Error && error.message) return error.message;
  return undefined;
}
