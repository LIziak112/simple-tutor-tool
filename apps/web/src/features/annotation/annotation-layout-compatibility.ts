import type { AnnotationSurfaceCompatibility } from "@tutor/contract";

type Evidence = Pick<
  AnnotationSurfaceCompatibility,
  "blocks" | "fonts" | "textRects"
>;
export const ANNOTATION_SURFACE_TOLERANCE_CSS_PX = 10;
type Rect = Evidence["textRects"][number];

/** 四边都对照保存基准，不能让位移与尺寸误差叠加。 */
function rectMatches(left: Rect, right: Rect): boolean {
  return [
    left.x - right.x,
    left.y - right.y,
    left.x + left.width - right.x - right.width,
    left.y + left.height - right.y - right.height,
  ].every((delta) => Math.abs(delta) <= ANNOTATION_SURFACE_TOLERANCE_CSS_PX);
}

/** Range 可拆成多个片段；仅合并同一结构块内、顺序连续且竖向重叠的行。 */
function textLines(evidence: Evidence): { block: number; rect: Rect }[] {
  const lines: { block: number; rect: Rect }[] = [];
  for (const rect of evidence.textRects) {
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    let block = -1;
    let area = Infinity;
    evidence.blocks.forEach((candidate, index) => {
      if (
        centerX >= candidate.x &&
        centerX <= candidate.x + candidate.width &&
        centerY >= candidate.y &&
        centerY <= candidate.y + candidate.height &&
        candidate.width * candidate.height <= area
      ) {
        block = index;
        area = candidate.width * candidate.height;
      }
    });
    const previous = lines.at(-1);
    if (
      previous &&
      block === previous.block &&
      rect.x >= previous.rect.x &&
      rect.y < previous.rect.y + previous.rect.height &&
      rect.y + rect.height > previous.rect.y
    ) {
      const right = Math.max(
        previous.rect.x + previous.rect.width,
        rect.x + rect.width,
      );
      const bottom = Math.max(
        previous.rect.y + previous.rect.height,
        rect.y + rect.height,
      );
      previous.rect.y = Math.min(previous.rect.y, rect.y);
      previous.rect.width = right - previous.rect.x;
      previous.rect.height = bottom - previous.rect.y;
    } else {
      lines.push({ block, rect: { ...rect } });
    }
  }
  return lines;
}

/** 规范化历史字体签名；有区域证据的稿件不以字体字符串独立阻断。 */
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

/** 区域身份与顺序严格对应；字体表示与 Range 拆分不独立阻断。 */
export function compatibleSurfaceEvidence(
  saved: Evidence,
  current: Evidence,
): boolean {
  const savedLines = textLines(saved);
  const currentLines = textLines(current);
  return (
    saved.blocks.length === current.blocks.length &&
    saved.blocks.every((block, index) => {
      const other = current.blocks[index];
      return (
        other !== undefined &&
        block.tag === other.tag &&
        (block.node === undefined || block.node === other.node) &&
        rectMatches(block, other)
      );
    }) &&
    savedLines.length === currentLines.length &&
    savedLines.every((line, index) => {
      const other = currentLines[index];
      return (
        other !== undefined &&
        line.block === other.block &&
        rectMatches(line.rect, other.rect)
      );
    })
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
