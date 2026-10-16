import { startFakeAiProvider } from "./fake-ai-provider";

/**
 * E2E 全局装配（SAI-33，B18）：在 Playwright 主进程启动假 AI 供应商
 * （127.0.0.1:8898，OpenAI 兼容端点 + 控制端同一监听，见 fake-ai-provider.ts
 * 头注）。被测 server 经 playwright.config.ts 的 E2E_FAKE_AI_BASE_URL 显式
 * 分流出站到本服务——业务链路全真，只有最后一跳指向受控假端点。
 *
 * 返回的 teardown 在整个 run 结束后关闭监听（Playwright globalSetup 约定）。
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const close = await startFakeAiProvider();
  return close;
}
