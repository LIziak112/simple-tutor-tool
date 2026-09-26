/**
 * 判分归一化：答案文本的标准化与判断题写法归一。
 *
 * 行为基线 = 旧版契约 docs/01_任务安排与契约.md §5 与旧版前端实现
 * （b4ee184: public/js/app.js 的 normalize/judgeOf），逐条沿用、不得增删语义：
 * 1. NFKC 规格化（全角→半角、兼容字符折叠）；
 * 2. 去掉全部空白；
 * 3. 形近负号 ﹣－–—− 统一映射为半角 -；
 * 4. 去掉 $ 与 \left \right；
 * 5. 首尾 trim。
 * 旧版未定义的行为（百分号、度数符号、千分位逗号等）一律不做等价转换，
 * 见任务报告「待决问题」。
 */

/** 形近负号字符集（与旧版一致；部分字符经 NFKC 后已是半角 -，替换幂等无害） */
const MINUS_LIKE = /[﹣－–—−]/g;

/**
 * 归一化答案文本（顺序严格沿用旧版：NFKC → 去空白 → 负号统一 → 去 $ 与 \left\right → trim）。
 * null/undefined 入参按空串处理（旧版 String(s == null ? '' : s) 的防御）。
 */
export function normalize(input: string | null | undefined): string {
  let t = String(input ?? "");
  t = t.normalize("NFKC");
  t = t.replace(/\s+/g, "");
  t = t.replace(MINUS_LIKE, "-");
  t = t.split("$").join("");
  t = t.split("\\left").join("").split("\\right").join("");
  return t.trim();
}

/** 判断题「正确」写法全集（旧版 §5；比较在 normalize + toUpperCase 之后） */
const JUDGE_TRUE = ["正确", "对", "√", "✔", "T", "TRUE", "是"];

/** 判断题「错误」写法全集（旧版 §5） */
const JUDGE_FALSE = ["错误", "错", "×", "✘", "F", "FALSE", "否"];

/**
 * 判断题写法归一化（旧版 judgeOf 原样移植）：
 * 把「对/√/T/TRUE/是…」归一为 "正确"、「错/×/F/FALSE/否…」归一为 "错误"；
 * 空串或不在全集内的写法返回 null（无法自动判定）。
 */
export function judgeOf(text: string): "正确" | "错误" | null {
  const n = normalize(text).toUpperCase();
  if (!n) return null;
  if (JUDGE_TRUE.includes(n)) return "正确";
  if (JUDGE_FALSE.includes(n)) return "错误";
  return null;
}
