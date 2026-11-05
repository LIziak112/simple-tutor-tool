// 由等待激活的 worker 核实所有同站页面，旧版和挂起标签也必须被看见。
self.addEventListener("message", (event) => {
  const data = event.data;
  const port = event.ports[0];
  if (
    data?.type !== "OWNCLASS_ACTIVATE_UPDATE" ||
    typeof data.requestId !== "string" ||
    !port
  )
    return;
  event.waitUntil(
    (async () => {
      try {
        const sourceId = event.source?.id;
        if (!sourceId) throw new Error("无法确认当前页面，更新已取消");
        const windows = (
          await self.clients.matchAll({
            type: "window",
            includeUncontrolled: true,
          })
        ).filter((client) => client.url.startsWith(self.registration.scope));
        if (windows.length !== 1 || windows[0].id !== sourceId)
          throw new Error("请先保存并关闭其它 OwnClass 页面，再在当前页面更新");
        await self.skipWaiting();
        port.postMessage({ requestId: data.requestId, ok: true });
      } catch (error) {
        port.postMessage({
          requestId: data.requestId,
          ok: false,
          reason:
            error instanceof Error
              ? error.message
              : "更新未获准，请保持页面打开",
        });
      }
    })(),
  );
});
