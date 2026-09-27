import { cn } from "cn";
import { Keyboard, Sigma } from "lucide-react";
import type { MathfieldElement } from "mathlive";
import { useEffect, useRef, useState } from "react";

/**
 * 手写题「最终答案」输入框（T2.8，架构 §5.4「最终答案输入」）：
 * - 普通输入（默认）：原生 <input>，iPad 上天然支持随手写（Scribble）；
 * - 数学键盘：MathLive <math-field>（复杂公式输入），**动态 import** 独立分包
 *   不进主包（mathlive ~1MB，ui-conventions 性能要求）；
 * - 禁 CDN：字体经 `mathlive/fonts.css` 随构建打包（Vite 解析相对 url()），
 *   运行时 `fontsDirectory = null` 禁止库自己注入字体请求、`soundsDirectory
 *   = null` 关闭按键音资源；
 * - 数学键盘的值取 `getValue("plain-text")`（线性可读文本，如 1/2），尽量与
 *   老师手写答案的判分口径一致（LaTeX 源码比较是 T3.x 判分增强的待决问题）。
 */

/** mathlive 是否已加载（成功后保持在内存，失败可重试） */
let mathliveLoaded = false;

/** 动态加载 mathlive 并注册 <math-field> 自定义元素；返回是否成功 */
async function ensureMathfield(): Promise<boolean> {
  if (mathliveLoaded || customElements.get("math-field")) {
    mathliveLoaded = true;
    return true;
  }
  // 字体随构建打包（禁 CDN）；模块本体也走动态 import（独立 chunk）
  await import("mathlive/fonts.css");
  const { MathfieldElement } = await import("mathlive");
  // 字体已由 fonts.css 打包：禁止运行时按 fontsDirectory 注入请求；
  // 声音资源（sounds/）不请求
  MathfieldElement.fontsDirectory = null;
  MathfieldElement.soundsDirectory = null;
  customElements.define("math-field", MathfieldElement);
  mathliveLoaded = true;
  return true;
}

export interface FinalAnswerInputProps {
  /** 当前值（普通模式=原始文本；数学模式=plain-text 线性化公式） */
  value: string;
  onChange: (value: string) => void;
  /** 无障碍标签 */
  label?: string;
}

export function FinalAnswerInput({
  value,
  onChange,
  label = "最终答案",
}: FinalAnswerInputProps) {
  const [mode, setMode] = useState<"plain" | "math">("plain");
  const [mathReady, setMathReady] = useState<boolean | null>(null);
  const mathRef = useRef<MathfieldElement | null>(null);

  // 切到数学键盘：懒加载 mathlive（失败给出错误态与重试）
  useEffect(() => {
    if (mode !== "math" || mathReady !== null) return;
    let alive = true;
    ensureMathfield()
      .then((ok) => {
        if (alive) setMathReady(ok);
      })
      .catch(() => {
        if (alive) setMathReady(false);
      });
    return () => {
      alive = false;
    };
  }, [mode, mathReady]);

  // math-field 是非受控自定义元素：值同步经 ref（React 19 不会替我们设 .value）
  useEffect(() => {
    if (mode === "math" && mathRef.current && mathRef.current.value !== value) {
      mathRef.current.value = value;
    }
  }, [mode, value]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <fieldset
          aria-label="输入方式"
          className="m-0 flex overflow-hidden rounded-lg border border-border p-0"
        >
          {(
            [
              ["plain", "普通输入", Keyboard],
              ["math", "数学键盘", Sigma],
            ] as const
          ).map(([m, text, Icon]) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              disabled={m === "math" && mathReady === false}
              onClick={() => setMode(m)}
              className={cn(
                "flex h-11 items-center gap-1.5 px-3 text-xs font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                mode === m
                  ? "bg-primary text-primary-foreground"
                  : "bg-background hover:bg-muted",
              )}
            >
              <Icon aria-hidden className="size-4" />
              {text}
            </button>
          ))}
        </fieldset>
      </div>

      {mode === "plain" && (
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="填写最终答案（如计算结果）"
          aria-label={label}
          className="h-11 rounded-md border border-border bg-background px-3 text-sm outline-none transition-colors focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      )}

      {mode === "math" && mathReady === null && (
        <p
          aria-live="polite"
          className="flex h-11 items-center rounded-md border border-border bg-muted/40 px-3 text-sm text-muted-foreground"
        >
          数学键盘加载中…
        </p>
      )}
      {mode === "math" && mathReady === false && (
        <div className="flex h-11 items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 text-sm text-destructive">
          <span>数学键盘加载失败，请先用普通输入</span>
          <button
            type="button"
            className="h-11 shrink-0 font-medium underline underline-offset-2"
            onClick={() => setMathReady(null)}
          >
            重试
          </button>
        </div>
      )}
      {mode === "math" && mathReady === true && (
        <math-field
          ref={mathRef}
          aria-label={label}
          class="math-field-final-answer block h-11 w-full rounded-md border border-border bg-background px-3 text-base outline-none"
          onInput={(event) => {
            // plain-text：线性可读公式文本（判分口径与手输一致的可能性最高）
            onChange(event.currentTarget.getValue("plain-text"));
          }}
        />
      )}
    </div>
  );
}
