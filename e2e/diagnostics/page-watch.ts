import type { Page, Request } from "@playwright/test";

/**
 * 失败现场记录器：给用例自己 launch 的浏览器用（跨内核用例的第二台设备）。
 *
 * Playwright 的 trace、截图只跟着夹具里的 page，用例自己开的浏览器失败时什么
 * 都留不下；CI 又只在作业失败时上传报告，首轮失败、重试通过的那一次只剩作业
 * 日志。所以从页面创建起记下控制台报错、页面异常、主框架导航、失败的和 4xx /
 * 5xx 的接口请求，失败时连同当前地址、页面可见文字和还没回来的接口请求一起
 * 打到标准输出。
 *
 * 只记路径、状态码和界面文字；不记请求体、响应体、查询串，登录链接里的令牌
 * 打码。不参与断言，记录本身出错也不影响用例。
 */
export function watchPageForFailure(page: Page, label: string) {
  const started = Date.now();
  const events: string[] = [];
  const pending = new Map<Request, number>();
  const at = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  const note = (text: string) => {
    if (events.length < 200) events.push(`${at()} ${text}`);
  };
  const pathOf = (url: string): string => {
    try {
      const path = new URL(url).pathname;
      return /^\/s\/[^/]{20,}$/.test(path) ? "/s/<登录令牌>" : path;
    } catch {
      return "<无法解析的地址>";
    }
  };
  const isApi = (url: string) => pathOf(url).startsWith("/api/");

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      note(`console.${message.type()} ${message.text().slice(0, 300)}`);
  });
  page.on("pageerror", (error) => {
    note(`pageerror ${String(error).slice(0, 300)}`);
  });
  page.on("crash", () => note("页面崩溃"));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) note(`导航到 ${pathOf(frame.url())}`);
  });
  page.on("request", (request) => {
    if (isApi(request.url())) pending.set(request, Date.now());
  });
  page.on("requestfinished", (request) => {
    pending.delete(request);
  });
  page.on("requestfailed", (request) => {
    pending.delete(request);
    note(
      `请求失败 ${request.method()} ${pathOf(request.url())} ${request.failure()?.errorText ?? ""}`,
    );
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && isApi(response.url()))
      note(
        `${response.status()} ${response.request().method()} ${pathOf(response.url())}`,
      );
  });

  return {
    /** 失败时调用：把现场打到标准输出。自身不抛错。 */
    async report(error: unknown): Promise<void> {
      const lines = [
        `PAGE_FAILURE ${label}：${String(error).split("\n")[0]?.slice(0, 300)}`,
        `PAGE_FAILURE 距页面创建 ${at()}`,
      ];
      try {
        lines.push(`PAGE_FAILURE 当前地址 ${pathOf(page.url())}`);
        const dom = await page.evaluate(() => ({
          readyState: document.readyState,
          online: navigator.onLine,
          articles: Array.from(document.querySelectorAll("article")).map(
            (article) => article.getAttribute("aria-label") ?? "",
          ),
          slots: Array.from(
            document.querySelectorAll(
              'article[aria-label="第 1 题"] [data-slot]',
            ),
          ).map((node) => node.getAttribute("data-slot") ?? ""),
          alerts: Array.from(
            document.querySelectorAll('[role="alert"], [role="status"]'),
          ).map((node) => (node.textContent ?? "").trim().slice(0, 200)),
          text: (document.body?.innerText ?? "")
            .replace(/\s+/g, " ")
            .slice(0, 1200),
        }));
        lines.push(
          `PAGE_FAILURE readyState=${dom.readyState} onLine=${dom.online}`,
          `PAGE_FAILURE 题卡 ${JSON.stringify(dom.articles)}`,
          `PAGE_FAILURE 第 1 题里的 data-slot ${JSON.stringify(dom.slots)}`,
          `PAGE_FAILURE 提示 ${JSON.stringify(dom.alerts)}`,
          `PAGE_FAILURE 可见文字 ${dom.text}`,
        );
      } catch (cause) {
        lines.push(
          `PAGE_FAILURE 页面读不出：${String(cause).split("\n")[0]?.slice(0, 300)}`,
        );
      }
      for (const [request, since] of pending)
        lines.push(
          `PAGE_FAILURE 还没回来 ${request.method()} ${pathOf(request.url())} 已等 ${((Date.now() - since) / 1000).toFixed(1)}s`,
        );
      for (const event of events.slice(-60))
        lines.push(`PAGE_FAILURE 记录 ${event}`);
      console.log(lines.join("\n"));
    },
  };
}
