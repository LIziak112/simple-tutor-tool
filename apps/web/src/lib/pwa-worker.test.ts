import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

interface Client {
  id: string;
  url: string;
}
interface WorkerMessage {
  data: unknown;
  source: { id: string } | null;
  ports: { postMessage(value: unknown): void }[];
  waitUntil(value: Promise<void>): void;
}
async function activate(
  clients: Client[],
  source: { id: string } | null = { id: "current" },
) {
  let onMessage: ((event: WorkerMessage) => void) | undefined;
  const skipWaiting = vi.fn(async () => {});
  runInNewContext(
    readFileSync(
      resolve(process.cwd(), "apps/web/public/pwa-update-worker.js"),
      "utf8",
    ),
    {
      URL,
      self: {
        registration: { scope: "https://ownclass.example/" },
        clients: { matchAll: vi.fn(async () => clients) },
        skipWaiting,
        addEventListener: (
          _name: string,
          listener: (event: WorkerMessage) => void,
        ) => {
          onMessage = listener;
        },
      },
    },
  );
  let work: Promise<void> = Promise.resolve();
  const reply = vi.fn();
  onMessage?.({
    data: { type: "OWNCLASS_ACTIVATE_UPDATE", requestId: "test" },
    source,
    ports: [{ postMessage: reply }],
    waitUntil: (value) => {
      work = value;
    },
  });
  await work;
  return { skipWaiting, reply };
}

it("只有当前请求页面时才允许新版本激活", async () => {
  const result = await activate([
    { id: "current", url: "https://ownclass.example/s/attempts/test" },
  ]);
  expect(result.skipWaiting).toHaveBeenCalledTimes(1);
  expect(result.reply).toHaveBeenCalledWith({ requestId: "test", ok: true });
});
it("存在旧版或未响应的其它标签也必须阻止激活", async () => {
  const result = await activate([
    { id: "current", url: "https://ownclass.example/s/attempts/test" },
    { id: "old", url: "https://ownclass.example/t/settings" },
  ]);
  expect(result.skipWaiting).not.toHaveBeenCalled();
  expect(result.reply).toHaveBeenCalledWith(
    expect.objectContaining({
      ok: false,
      reason: expect.stringContaining("其它 OwnClass 页面"),
    }),
  );
});
it("来源不属于枚举出的真实页面时拒绝激活", async () => {
  const result = await activate(
    [{ id: "current", url: "https://ownclass.example/" }],
    { id: "unknown" },
  );
  expect(result.skipWaiting).not.toHaveBeenCalled();
  expect(result.reply).toHaveBeenCalledWith(
    expect.objectContaining({ ok: false }),
  );
});
it("无来源页面的请求不允许激活", async () => {
  const result = await activate([], null);
  expect(result.skipWaiting).not.toHaveBeenCalled();
});
