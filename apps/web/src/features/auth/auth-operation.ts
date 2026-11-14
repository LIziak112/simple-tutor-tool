import type { QueryClient } from "@tanstack/react-query";
import { captureAccountIdentity } from "./account-identity";
export type AuthRole = "student" | "teacher";
export class AuthCancelledError extends Error {
  constructor(readonly committedRoles: readonly AuthRole[] = []) {
    super("账号状态已变化，本次操作已取消，请重试");
    this.name = "AuthCancelledError";
  }
}
/** 同一认证操作协调既有两份me；自己的合法写会续接凭据，外部写永不续接。 */
export function createAuthOperation(client: QueryClient) {
  const gates = {
    student: captureAccountIdentity(client, "student"),
    teacher: captureAccountIdentity(client, "teacher"),
  };
  let roles: readonly AuthRole[] = ["student", "teacher"];
  const controller = new AbortController();
  let closed = false;
  let consumed = false;
  const committed = new Set<AuthRole>();
  const isCurrent = () =>
    !closed && roles.every((role) => gates[role].isCurrent());
  const assertCurrent = () => {
    if (!isCurrent()) throw new AuthCancelledError([...committed]);
  };
  return {
    select(selected: readonly AuthRole[]) {
      if (committed.size) throw new AuthCancelledError([...committed]);
      roles = selected;
      assertCurrent();
    },
    isCurrent,
    assertCurrent,
    signal: controller.signal,
    get consumed() {
      return consumed;
    },
    consume(action: () => void) {
      assertCurrent();
      action();
      consumed = true;
    },
    commit(role: AuthRole, write: () => void, reset = false) {
      assertCurrent();
      const gate = gates[role];
      if (!(reset ? gate.commitReset(write) : gate.commit(write)))
        throw new AuthCancelledError([...committed]);
      gate.finish();
      gates[role] = captureAccountIdentity(client, role);
      committed.add(role);
      assertCurrent();
    },
    finish() {
      closed = true;
      controller.abort(new AuthCancelledError([...committed]));
      gates.student.finish();
      gates.teacher.finish();
    },
  };
}
export type AuthOperation = ReturnType<typeof createAuthOperation>;
