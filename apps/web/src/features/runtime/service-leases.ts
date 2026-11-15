import type { ApiServices } from "./ports/api-services";

/** 仅按调用方捕获的会话对象寻址；绑定不可替换，没有“当前端口”回退。 */
const leases = new WeakMap<object, ApiServices>();
export function bindServiceLease(session: object, clients: ApiServices): void {
  const existing = leases.get(session);
  if (existing !== undefined && existing !== clients)
    throw new Error("不可重绑已捕获的会话端口");
  leases.set(session, clients);
}
export function serviceLease(session: object): ApiServices {
  const clients = leases.get(session);
  if (clients === undefined) throw new Error("会话尚未绑定领域端口");
  return clients;
}
