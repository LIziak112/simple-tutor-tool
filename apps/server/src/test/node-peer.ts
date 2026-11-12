/** 在 app.request 中模拟 Node 适配器提供的对端地址。 */
export function nodePeerBindings(address?: string) {
  return address === undefined
    ? undefined
    : { incoming: { socket: { remoteAddress: address } } };
}
