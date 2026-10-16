import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AiLinkShareBox } from "./AiLinkShareBox";
import type { AiLinkShareState } from "./use-ai-send-controller";

/**
 * SAI-30 链接查看/复制/降级组件测试（B15 必测映射）：
 * - 呈现面：题号/生成时刻/有效期 + 「获得链接者可读答案解析」如实说明 +
 *   手动复制（链接恒可见可选，复制失败不丢链接）；
 * - 降级面（外部 AI 读不了链接时）：拉取分享正文提取文字入剪贴板、解析
 *   材料链接给下载；拉取被拒（403/404）= 当前权限拒绝——不写剪贴板不
 *   渲染下载项（未完成/已失效时降级同拒，门禁在服务端逐次实时核对）；
 * - 呈现与降级都不产生「已回信/已收到」口径（外部未写回不冒充）。
 */

const LINK: AiLinkShareState = {
  questionId: "q-a",
  taskId: "task-1",
  url: "https://tutor.example.com/api/public/ai/share/AbCdEf123456",
  snapshotAt: "2026-10-16T08:00:00.000Z",
  expiresAt: "2026-10-17T08:00:00.000Z",
  copyFailed: true,
};

/** 分享正文样例（含材料链接与缺失说明，与 public-ai-share 路由同构） */
const SHARE_HTML = `<!doctype html><html><body>
<h1>AI 伴学分享（单题快照）</h1>
<p class="meta">题号：第 3 题</p>
<h2>题面</h2><pre class="md">1+1=?</pre>
<h2>参考答案</h2><pre class="md">2</pre>
<h2>材料（仅本题选定附件）</h2>
<ul class="materials">
<li><a href="/api/public/ai/share/AbCdEf123456/materials/0.png">题面圈画第 1 页（PNG 图片）</a></li>
<li>草稿第 1 页——<span class="missing">缺失：材料文件缺失</span></li>
</ul>
</body></html>`;

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function stubClipboard(
  writeText: ((text: string) => Promise<void>) | undefined,
): void {
  Object.defineProperty(navigator, "clipboard", {
    value: writeText === undefined ? undefined : { writeText },
    configurable: true,
  });
}

/** 期望串按本地时区计算（组件格式化同样走本地时区，CI/本地皆稳） */
function localTimeOf(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function renderBox(over: Partial<AiLinkShareState> = {}) {
  const onRegenerate = vi.fn();
  const onRevoke = vi.fn();
  const onRetryCopy = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <AiLinkShareBox
      questionLabel="第 3 题"
      link={{ ...LINK, ...over }}
      sending={false}
      onRegenerate={onRegenerate}
      onRevoke={onRevoke}
      onRetryCopy={onRetryCopy}
    />,
  );
  return { onRegenerate, onRevoke, onRetryCopy, ...view };
}

describe("AiLinkShareBox（SAI-30 链接查看/复制/降级）", () => {
  it("呈现面：题号/生成时刻/有效期 + 获得链接者可读答案解析说明 + 手动复制链接恒可见", () => {
    renderBox();
    expect(screen.getByText(/第 3 题/)).toBeTruthy();
    // 时间与前后缀同段落：子串正则匹配（时区按本地计算，CI/本地皆稳）
    expect(
      screen.getByText(new RegExp(localTimeOf(LINK.snapshotAt))),
    ).toBeTruthy();
    expect(
      screen.getByText(new RegExp(localTimeOf(LINK.expiresAt))),
    ).toBeTruthy();
    // 如实说明：不以「仅 AI 可看」误导（需求 §10）
    expect(
      screen.getByText(/获得链接者可读取本题参考答案、解析与选定材料/),
    ).toBeTruthy();
    // 区块 aria-label 与输入框同名：按 textbox role 精确定位输入框
    const input = screen.getByRole("textbox", {
      name: "AI 链接",
    }) as HTMLInputElement;
    expect(input.value).toBe(LINK.url);
    expect(input.readOnly).toBe(true);
  });

  it("重新生成/撤销是显式动作（仍按当前权限，服务端逐次裁决）", () => {
    const { onRegenerate, onRevoke } = renderBox();
    fireEvent.click(screen.getByRole("button", { name: "重新生成链接" }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "撤销链接" }));
    expect(onRevoke).toHaveBeenCalledTimes(1);
  });

  it("降级：外部读不了链接时拉取正文→复制文字+材料下载项；链接保持可复制", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const fetchSpy = vi.fn().mockResolvedValue(htmlResponse(SHARE_HTML));
    vi.stubGlobal("fetch", fetchSpy);
    renderBox();
    fireEvent.click(
      screen.getByRole("button", { name: "外部读不了？复制本题文字" }),
    );
    // 拉的是票据自身 URL（授权与留痕都走这条真实链路）
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(LINK.url));
    await waitFor(() =>
      expect(screen.getByText(/已复制本题文字/)).toBeTruthy(),
    );
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0]?.[0] ?? "";
    expect(copied).toContain("1+1=?");
    expect(copied).toContain("2");
    // 材料下载项来自正文解析（只列就绪附件；缺失项说明不伪装成下载）
    const materialLink = screen.getByRole("link", {
      name: /题面圈画第 1 页/,
    }) as HTMLAnchorElement;
    expect(materialLink.getAttribute("href")).toBe(
      "/api/public/ai/share/AbCdEf123456/materials/0.png",
    );
    expect(materialLink.hasAttribute("download")).toBe(true);
    expect(screen.getByText(/缺失：材料文件缺失/)).toBeTruthy();
    vi.unstubAllGlobals();
    stubClipboard(undefined);
  });

  it("降级被拒（403/404）：不写剪贴板不渲染下载项，如实给拒绝文案", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(htmlResponse("分享链接已失效", 403));
    vi.stubGlobal("fetch", fetchSpy);
    renderBox();
    fireEvent.click(
      screen.getByRole("button", { name: "外部读不了？复制本题文字" }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(/链接已失效或当前无权限，复制与下载被拒绝/),
      ).toBeTruthy(),
    );
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "题面圈画第 1 页" })).toBeNull();
    vi.unstubAllGlobals();
    stubClipboard(undefined);
  });

  it("降级网络失败：与权限拒绝区分（提示稍后重试，不谎报失效）", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchSpy);
    renderBox();
    fireEvent.click(
      screen.getByRole("button", { name: "外部读不了？复制本题文字" }),
    );
    await waitFor(() =>
      expect(screen.getByText(/读取分享内容失败/)).toBeTruthy(),
    );
    vi.unstubAllGlobals();
  });

  it("降级服务端故障（500）：与票据失效区分（提示稍后重试，不误导重新生成）", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(htmlResponse("内部错误", 500));
    vi.stubGlobal("fetch", fetchSpy);
    renderBox();
    fireEvent.click(
      screen.getByRole("button", { name: "外部读不了？复制本题文字" }),
    );
    await waitFor(() =>
      expect(screen.getByText(/分享内容读取失败/)).toBeTruthy(),
    );
    // 不得归因为「链接已失效或当前无权限」——500 重生成链接解决不了
    expect(screen.queryByText(/链接已失效/)).toBeNull();
    vi.unstubAllGlobals();
  });

  it("链接 URL 变化（重新生成）：降级解析的旧内容清空，不残留旧票据材料", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(htmlResponse(SHARE_HTML));
    vi.stubGlobal("fetch", fetchSpy);
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    // 生产父级（Composer）以 key=link.url 挂载：URL 变化即重挂复位降级区
    const KeyedBox = ({ link }: { link: AiLinkShareState }) => (
      <AiLinkShareBox
        key={link.url}
        questionLabel="第 3 题"
        link={link}
        sending={false}
        onRegenerate={vi.fn()}
        onRevoke={vi.fn()}
        onRetryCopy={vi.fn().mockResolvedValue(undefined)}
      />
    );
    const { rerender } = render(<KeyedBox link={LINK} />);
    fireEvent.click(
      screen.getByRole("button", { name: "外部读不了？复制本题文字" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: /题面圈画第 1 页/ }),
      ).toBeTruthy(),
    );
    // 重新生成链接：换 URL 重挂——旧票据的解析文字/材料清单必须复位
    rerender(
      <KeyedBox
        link={{
          ...LINK,
          url: "https://tutor.example.com/api/public/ai/share/NewToken999",
        }}
      />,
    );
    expect(screen.queryByRole("link", { name: /题面圈画第 1 页/ })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    vi.unstubAllGlobals();
    stubClipboard(undefined);
  });

  it("降级按钮连击只发一次请求（ref 守卫，不留痕翻倍/双写剪贴板）", async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchSpy = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    renderBox();
    const button = screen.getByRole("button", {
      name: "外部读不了？复制本题文字",
    });
    // 同一渲染帧内双击：closure 里的 phase 还是 idle，只有 ref 能挡住第二次
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveFetch?.(htmlResponse(SHARE_HTML));
    });
    await waitFor(() =>
      expect(screen.getByText(/已复制本题文字/)).toBeTruthy(),
    );
    expect(writeText).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    stubClipboard(undefined);
  });
});
