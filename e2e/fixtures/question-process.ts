import { readFileSync } from "node:fs";

export function questionProcessFixture(unit: string, suffix: string) {
  const sample = (filename: string) =>
    readFileSync(
      new URL(`../../samples/qm/${filename}`, import.meta.url),
      "utf8",
    ).replaceAll("\r\n", "\n");
  const old = sample("valid-08-旧七型混合题.md");
  const match = sample("valid-04-七选五.md");
  const ordering = sample("valid-05-固定项排序.md");
  return [
    "---",
    "kind: practice",
    `unit: ${unit}`,
    "---",
    `# ${unit}`,
    "",
    old
      .slice(old.indexOf("::::question"))
      .replace(/^::image.*\n/gm, "")
      .replace(
        ":::solution",
        ":::hint\n先比较绝对值与原数。\n:::\n\n:::solution",
      ),
    '::::question{type=response difficulty=1 knowledge="过程验收"}',
    "写下你的观察。",
    ":::answer",
    "观察示例。",
    ":::",
    "::::",
    "",
    match
      .slice(match.indexOf("::::material"))
      .replaceAll("qx-1", `qp-match-${suffix}`)
      .replaceAll("mat-1", `qp-mat-${suffix}`)
      .replaceAll("grp-1", `qp-grp-${suffix}`),
    ordering
      .slice(
        ordering.indexOf("::::question"),
        ordering.indexOf("::::question{id=px-2"),
      )
      .replaceAll("px-1", `qp-sort-${suffix}`),
  ].join("\n");
}
