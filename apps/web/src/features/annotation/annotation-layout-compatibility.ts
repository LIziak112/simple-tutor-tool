import type { AnnotationSurfaceCompatibility } from "@tutor/contract";

type Evidence = Pick<
  AnnotationSurfaceCompatibility,
  "blocks" | "fonts" | "textRects"
>;

/** 只消除内核 CSS 序列化差异，真实字号、字重与字距继续参与核对。 */
export function normalizeSurfaceFont(
  font: readonly string[],
): AnnotationSurfaceCompatibility["fonts"][number] {
  const numeric = (value: string) =>
    value.replace(/-?\d+(?:\.\d+)?/g, (number) =>
      String(Math.round(Number(number) * 1000) / 1000),
    );
  return [
    (font[0] ?? "")
      .split(",")
      .map((family) =>
        family
          .trim()
          .replace(/^(["'])(.*)\1$/, "$2")
          .toLowerCase(),
      )
      .join(","),
    numeric(font[1] ?? ""),
    font[2] === "normal" ? "400" : font[2] === "bold" ? "700" : (font[2] ?? ""),
    numeric(font[3] ?? ""),
    font[4] === "normal" ? "0px" : numeric(font[4] ?? ""),
  ];
}

/** 逐块及逐文本行比较，半像素基线差异不能放宽成任意重排。 */
export function compatibleSurfaceEvidence(
  saved: Evidence,
  current: Evidence,
): boolean {
  const rectsMatch = (
    left: Evidence["textRects"],
    right: Evidence["textRects"],
  ) =>
    left.length === right.length &&
    left.every((rect, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        (["x", "y", "width", "height"] as const).every(
          (key) => Math.abs(rect[key] - other[key]) <= 0.75,
        )
      );
    });
  return (
    saved.blocks.every(
      (block, index) => block.tag === current.blocks[index]?.tag,
    ) &&
    rectsMatch(saved.blocks, current.blocks) &&
    rectsMatch(saved.textRects, current.textRects) &&
    JSON.stringify(saved.fonts.map(normalizeSurfaceFont)) ===
      JSON.stringify(current.fonts.map(normalizeSurfaceFont))
  );
}

/** 历史布局只有哈希：枚举已知内核表示后仍必须命中原签名，不能用新签名代替旧证据。 */
export function legacySurfaceFontCandidates(
  fonts: readonly (readonly string[])[],
): AnnotationSurfaceCompatibility["fonts"][] {
  const candidates: AnnotationSurfaceCompatibility["fonts"][] = [
    fonts.map((row) => [
      row[0] ?? "",
      row[1] ?? "",
      row[2] ?? "",
      row[3] ?? "",
      row[4] ?? "",
    ]),
  ];
  for (const quoted of [false, true]) {
    for (const webkitNumbers of [false, true]) {
      candidates.push(
        fonts.map((row) => {
          const family = (row[0] ?? "")
            .split(",")
            .map((value) => {
              const bare = value.trim().replace(/^(["'])(.*)\1$/, "$2");
              return quoted && /\s/.test(bare) ? `"${bare}"` : bare;
            })
            .join(", ");
          const size = Number.parseFloat(row[1] ?? "");
          const height = Number.parseFloat(row[3] ?? "");
          const cssNumber = (value: number) => `${Number(value.toFixed(6))}px`;
          return [
            family,
            Number.isFinite(size)
              ? cssNumber(
                  webkitNumbers
                    ? Math.fround(size)
                    : Math.round(size * 1000) / 1000,
                )
              : (row[1] ?? ""),
            row[2] ?? "",
            Number.isFinite(height) && size > 0
              ? cssNumber(
                  webkitNumbers
                    ? Math.fround(
                        Math.fround(size) *
                          Math.fround(
                            Math.round((height / size) * 1000) / 1000,
                          ),
                      )
                    : Math.round(height * 1000) / 1000,
                )
              : (row[3] ?? ""),
            row[4] ?? "",
          ];
        }),
      );
    }
  }
  return candidates;
}
