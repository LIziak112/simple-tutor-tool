/**
 * 栅格化共享原语（T6R.19 合成图 / T6R.20 标注底图共用；审查修复 6+7 抽出）：
 * 教师节哨兵、PNG 魔数校验、单步异步超时、图片预解码、整页空白采样——两条
 * 管线此前各持一份机械副本；字体按当前导出节点收集，只缓存成功资源。
 */

/** 教师模板节哨兵（学生载荷守卫：题面混入教师域内容即拒绝生成） */
export const TEACHER_SECTION_MARKERS = [
  "**参考答案**",
  "**详解**",
  "**判定**",
  "**老师评语**",
  ":::solution",
  ":::answer",
] as const;

/** PNG 魔数（编码产物校验：空输出/非 PNG 拒绝落盘） */
export const PNG_MAGIC = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
] as const;

/** 单步异步超时（iOS/旧 WebKit 的 decode()/canvas 挂起防线，超时转分类失败） */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** 图片 URL 预解码（new Image + decode 优先；失败/不支持回退 onload） */
export async function preloadImages(urls: readonly string[]): Promise<void> {
  await Promise.all(
    urls.map(
      (url) =>
        new Promise<void>((resolve, reject) => {
          const image = new Image();
          const fail = (): void => reject(new Error(`图片加载失败：${url}`));
          if (typeof image.decode === "function") {
            image.src = url;
            image.decode().then(
              () => resolve(),
              () => fail(),
            );
          } else {
            image.onload = () => resolve();
            image.onerror = () => fail();
            image.src = url;
          }
        }),
    ),
  );
}

/** 采样判断 PNG 是否整页白色（透明像素不计；NaN 等异常值不算白） */
export function rgbaSampleAllBlank(data: Uint8ClampedArray): boolean {
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] === 0) continue; // 透明像素不计
    if (!(data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255)) {
      return false;
    }
  }
  return true;
}

/**
 * 采样判断整页空白（「不下载空白 PNG 后显示成功」的产物侧防线）：整页绘制
 * 缩到 64×64 离屏小画布后**单次** getImageData 读回、内存里取样判断——
 * 逐像素 getImageData 是 4096 次同步 GPU 读回，在 iPad WebKit 会引发整机
 * 卡顿（T6R.19 审查修复轮 HIGH）。画布不可用时不误杀（返回非空白）。
 */
export async function samplePngBlank(blob: Blob): Promise<boolean> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("空白校验图加载失败"));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return false;
    ctx.drawImage(image, 0, 0, 64, 64);
    return rgbaSampleAllBlank(ctx.getImageData(0, 0, 64, 64).data);
  } catch {
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Blob 头 8 字节是否 PNG 魔数（<8 字节直接判否） */
export async function pngBlobHasMagic(blob: Blob): Promise<boolean> {
  if (blob.size < 8) return false;
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  return PNG_MAGIC.every((byte, i) => head[i] === byte);
}

// ---------- 当前导出节点的自包含字体 ----------

const fontResourceByUrl = new Map<string, Promise<string>>();
const FONT_RESOURCE_TIMEOUT_MS = 15_000;

function normalizeFontFamily(value: string): string {
  return value
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase();
}

/** 拒绝 HTML 错误页等假成功响应；字体格式由文件头决定，不依赖服务器 MIME。 */
function fontMime(bytes: Uint8Array): string {
  const signature = String.fromCharCode(...bytes.slice(0, 4));
  if (signature === "wOF2") return "font/woff2";
  if (signature === "wOFF") return "font/woff";
  if (signature === "OTTO") return "font/otf";
  if (signature === "true" || signature === "\u0000\u0001\u0000\u0000")
    return "font/ttf";
  throw new Error("字体响应不是有效的字体文件，请重试");
}

async function readFontDataUrl(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(FONT_RESOURCE_TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    throw new Error("字体加载失败或超时，请重试");
  }
  if (!response.ok) throw new Error(`字体加载失败（HTTP ${response.status}）`);
  const buffer = await response.arrayBuffer();
  const mime = fontMime(new Uint8Array(buffer));
  if (typeof FontFace === "function") {
    try {
      // 只校验资源，不加入页面字体集合，不改变题面排版。
      await new FontFace("OwnClassExportFont", buffer).load();
    } catch {
      throw new Error("字体文件无法解码，请重试");
    }
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("字体编码失败，请重试"));
    reader.onload = () => {
      if (typeof reader.result !== "string")
        reject(new Error("字体编码失败，请重试"));
      else resolve(reader.result);
    };
    reader.readAsDataURL(new Blob([buffer], { type: mime }));
  });
}

function fontDataUrl(url: string): Promise<string> {
  const cached = fontResourceByUrl.get(url);
  if (cached) return cached;
  const pending = withTimeout(
    readFontDataUrl(url),
    FONT_RESOURCE_TIMEOUT_MS,
    "字体加载超时，请重试",
  );
  fontResourceByUrl.set(url, pending);
  void pending.catch(() => {
    // 不经过 html-to-image 的资源缓存：该库把下载失败缓存成空字符串。
    fontResourceByUrl.delete(url);
  });
  return pending;
}

function fontFaceRules(sheet: CSSStyleSheet): CSSFontFaceRule[] {
  const result: CSSFontFaceRule[] = [];
  const visit = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if (rule.type === CSSRule.FONT_FACE_RULE)
        result.push(rule as CSSFontFaceRule);
      else if (rule.type === CSSRule.IMPORT_RULE) {
        const imported = (rule as CSSImportRule).styleSheet;
        if (imported) result.push(...fontFaceRules(imported));
      } else if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules);
    }
  };
  try {
    visit(sheet.cssRules);
  } catch {
    throw new Error("字体样式表无法读取，请重试");
  }
  return result;
}

/** 节点字体集合会随挂载变化；只复用字体字节，不复用整个页面的 CSS 快照。 */
export async function collectFontEmbedCss(node: HTMLElement): Promise<string> {
  const owner = node.ownerDocument;
  const usedFonts = new Set<string>();
  for (const element of [node, ...node.querySelectorAll("*")]) {
    for (const family of getComputedStyle(element).fontFamily.split(","))
      usedFonts.add(normalizeFontFamily(family));
  }
  const rules = Array.from(owner.styleSheets)
    .flatMap(fontFaceRules)
    .filter((rule) =>
      usedFonts.has(
        normalizeFontFamily(rule.style.getPropertyValue("font-family")),
      ),
    );
  const css = await Promise.all(
    rules.map(async (rule) => {
      const src = rule.style.getPropertyValue("src");
      const sources = Array.from(
        src.matchAll(
          /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)\s*(?:format\(\s*["']?([^"')]+)["']?\s*\))?/gi,
        ),
      );
      const source =
        sources.find((match) => match[4]?.toLowerCase() === "woff2") ??
        sources[0];
      const resource = source?.[1] ?? source?.[2] ?? source?.[3];
      if (!resource) throw new Error("字体资源地址为空或不受支持，请重试");
      const url = new URL(
        resource,
        rule.parentStyleSheet?.href ?? owner.baseURI,
      );
      if (
        url.protocol !== "data:" &&
        url.origin !== new URL(owner.baseURI).origin
      )
        throw new Error("字体必须使用本站资源，请重试");
      const embedded = await fontDataUrl(url.href);
      const declarations = Array.from(
        { length: rule.style.length },
        (_, index) => rule.style[index],
      )
        .filter(
          (property): property is string =>
            property !== undefined && property !== "src",
        )
        .map(
          (property) =>
            `${property}: ${rule.style.getPropertyValue(property)};`,
        );
      return `@font-face { ${declarations.join(" ")} src: url("${embedded}"); }`;
    }),
  );
  if (owner.fonts)
    await withTimeout(
      owner.fonts.ready,
      FONT_RESOURCE_TIMEOUT_MS,
      "字体就绪等待超时，请重试",
    );
  return css.join("\n");
}
