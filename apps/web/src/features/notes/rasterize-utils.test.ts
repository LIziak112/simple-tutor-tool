import { afterEach, describe, expect, it, vi } from "vitest";
import { collectFontEmbedCss } from "./rasterize-utils";

const styles: HTMLStyleElement[] = [];
function fixture(
  name: string,
  src = `url("/fonts/${name}.woff2") format("woff2")`,
) {
  const style = document.createElement("style");
  style.textContent = `@font-face { font-family: "${name}"; font-weight: 400; src: ${src}; }
    @font-face { font-family: "${name}"; font-weight: 700; src: ${src}; }`;
  document.head.append(style);
  styles.push(style);
  // jsdom 会丢弃 @font-face 的 src 描述符；只补齐此浏览器 CSSOM 差异。
  for (const rule of Array.from(style.sheet?.cssRules ?? [])) {
    const declaration = (rule as CSSFontFaceRule).style;
    const getProperty = declaration.getPropertyValue.bind(declaration);
    vi.spyOn(declaration, "getPropertyValue").mockImplementation((property) =>
      property === "src" ? src : getProperty(property),
    );
  }
  const node = document.createElement("div");
  node.style.fontFamily = name;
  document.body.append(node);
  return node;
}
function fontResponse(status = 200, text?: string) {
  return new Response(text ?? new Uint8Array([119, 79, 70, 50, 0, 0, 0, 0]), {
    status,
  });
}
afterEach(() => {
  for (const style of styles.splice(0)) style.remove();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("导出字体按当前节点收集，只缓存成功资源", () => {
  it("字体请求挂起有超时，失败后可重试", async () => {
    vi.useFakeTimers();
    const fetchFont = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>(() => {}))
      .mockResolvedValue(fontResponse());
    vi.stubGlobal("fetch", fetchFont);
    const node = fixture("TimeoutMath");
    const rejection = expect(collectFontEmbedCss(node)).rejects.toThrow(
      "字体加载超时",
    );
    await vi.advanceTimersByTimeAsync(15_001);
    await rejection;
    vi.useRealTimers();
    expect(await collectFontEmbedCss(node)).toContain(
      "data:font/woff2;base64,",
    );
    expect(fetchFont).toHaveBeenCalledTimes(2);
  });

  it("浏览器不能解码的字体不能写入成功缓存", async () => {
    const loadFont = vi
      .fn()
      .mockRejectedValueOnce(new Error("坏字体"))
      .mockResolvedValue(undefined);
    vi.stubGlobal(
      "FontFace",
      class {
        load = loadFont;
      },
    );
    const fetchFont = vi.fn(async () => fontResponse());
    vi.stubGlobal("fetch", fetchFont);
    const node = fixture("UndecodableMath");
    await expect(collectFontEmbedCss(node)).rejects.toThrow("字体");
    expect(await collectFontEmbedCss(node)).toContain(
      "data:font/woff2;base64,",
    );
    expect(fetchFont).toHaveBeenCalledTimes(2);
  });

  it("同一节点从普通文本变为公式时重新识别字体，且不收集节点外字体", async () => {
    const fetchFont = vi.fn(async (_url: string, _init?: RequestInit) =>
      fontResponse(),
    );
    vi.stubGlobal("fetch", fetchFont);
    const surface = fixture("LateMath");
    surface.style.fontFamily = "sans-serif";
    fixture("OutsideMath");
    expect(await collectFontEmbedCss(surface)).toBe("");
    surface.innerHTML = '<span style="font-family:LateMath">x²</span>';
    const css = await collectFontEmbedCss(surface);
    expect(css).toContain("LateMath");
    expect(css).not.toContain("OutsideMath");
    expect(css).toContain("data:font/woff2;base64,");
    expect(css).toContain("font-weight: 700");
    expect(fetchFont).toHaveBeenCalledTimes(1);
  });

  it("同资源并发共享、成功复用，不永久缓存节点的 CSS", async () => {
    const fetchFont = vi.fn(async () => fontResponse());
    vi.stubGlobal("fetch", fetchFont);
    const node = fixture("SharedMath");
    const [first, second] = await Promise.all([
      collectFontEmbedCss(node),
      collectFontEmbedCss(node),
    ]);
    expect(first).toBe(second);
    await collectFontEmbedCss(node);
    expect(fetchFont).toHaveBeenCalledTimes(1);
    node.style.fontFamily = "sans-serif";
    expect(await collectFontEmbedCss(node)).toBe("");
  });

  it("字体 404 后拒绝导出，网络恢复后真实重试", async () => {
    const fetchFont = vi
      .fn()
      .mockResolvedValueOnce(fontResponse(404))
      .mockResolvedValue(fontResponse());
    vi.stubGlobal("fetch", fetchFont);
    const node = fixture("RetryMath");
    await expect(collectFontEmbedCss(node)).rejects.toThrow("字体");
    expect(await collectFontEmbedCss(node)).toContain(
      "data:font/woff2;base64,",
    );
    expect(fetchFont).toHaveBeenCalledTimes(2);
  });

  it("拒绝返回 HTML 的假成功响应，不能污染成功缓存", async () => {
    const fetchFont = vi
      .fn()
      .mockResolvedValueOnce(fontResponse(200, "<!doctype html>"))
      .mockResolvedValue(fontResponse());
    vi.stubGlobal("fetch", fetchFont);
    const node = fixture("BadPayloadMath");
    await expect(collectFontEmbedCss(node)).rejects.toThrow("字体");
    expect(await collectFontEmbedCss(node)).toContain(
      "data:font/woff2;base64,",
    );
    expect(fetchFont).toHaveBeenCalledTimes(2);
  });

  it("空源与外站字体拒绝导出，不请求外站", async () => {
    const fetchFont = vi.fn();
    vi.stubGlobal("fetch", fetchFont);
    await expect(
      collectFontEmbedCss(fixture("EmptyMath", 'url("")')),
    ).rejects.toThrow("字体");
    await expect(
      collectFontEmbedCss(
        fixture("RemoteMath", 'url("https://outside.example/font.woff2")'),
      ),
    ).rejects.toThrow("字体");
    expect(fetchFont).not.toHaveBeenCalled();
  });

  it("按样式表地址解析相对路径，并优先使用 woff2", async () => {
    const fetchFont = vi.fn(async (_url: string, _init?: RequestInit) =>
      fontResponse(),
    );
    vi.stubGlobal("fetch", fetchFont);
    const node = fixture(
      "RelativeMath",
      'url("fonts/old.woff") format("woff"), url("fonts/RelativeMath.woff2") format("woff2")',
    );
    const sheet = styles.at(-1)?.sheet;
    if (!sheet) throw new Error("测试样式表未挂载");
    Object.defineProperty(sheet, "href", {
      value: new URL("/assets/math.css", document.baseURI).href,
    });
    await collectFontEmbedCss(node);
    expect(fetchFont.mock.calls[0]?.[0]).toBe(
      new URL("/assets/fonts/RelativeMath.woff2", document.baseURI).href,
    );
  });
});
