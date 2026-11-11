import {
  ATTEMPT_TIME_LIMIT_MINUTES_MAX,
  attemptTimeLimitMinutesSchema,
} from "@tutor/contract";
import { useId } from "react";
import { Input } from "@/components/ui/input";

/** 常用时长（分钟）：行测 120、申论 150/180 都在列；其余走自定义 */
const PRESETS = [15, 30, 45, 60, 90, 120, 150, 180] as const;

export interface TimeLimitSelection {
  /** 是否限时 */
  enabled: boolean;
  /** 时长（分钟，1–600）；enabled=false 时保留上次值便于再次开启 */
  minutes: number;
  /** 缺省表示预设；自定义输入清空后仍保留编辑状态。 */
  customText?: string;
}

/** 落地页初值：有单元推荐时长 → 默认开启并取推荐值；否则关闭、缺省 60 */
export function initialTimeLimitOf(
  recommended: number | undefined,
): TimeLimitSelection {
  return recommended !== undefined
    ? {
        enabled: true,
        minutes: recommended,
        ...(!PRESETS.some((preset) => preset === recommended)
          ? { customText: String(recommended) }
          : {}),
      }
    : { enabled: false, minutes: 60 };
}

/** 选择结果 → 开卷请求字段（不限时不携带键） */
export function timeLimitStartOption(
  selection: TimeLimitSelection,
): { timeLimitMinutes?: number } | null {
  if (!selection.enabled) return {};
  const parsed = attemptTimeLimitMinutesSchema.safeParse(
    selection.customText === undefined
      ? selection.minutes
      : Number(selection.customText),
  );
  return parsed.success ? { timeLimitMinutes: parsed.data } : null;
}

/**
 * 开卷前「限时测试」选择器（模块 2，通用：任何练习单元 / 作业都可限时）：
 * 开关 + 常用时长 + 自定义分钟。说明文案点明服务端时钟与到时规则，不把权限
 * 语义混进来（限不限时都由学习者自己决定）。
 */
export function TimeLimitPicker({
  value,
  recommended,
  onChange,
}: {
  value: TimeLimitSelection;
  recommended: number | undefined;
  onChange: (next: TimeLimitSelection) => void;
}) {
  const toggleId = useId();
  const customId = useId();
  const invalid = timeLimitStartOption(value) === null;

  return (
    <div
      className="flex min-w-0 flex-col gap-2 rounded-xl bg-muted/40 p-3"
      data-testid="time-limit-picker"
    >
      <label
        htmlFor={toggleId}
        className="flex min-h-11 cursor-pointer items-center justify-between gap-3"
      >
        <span className="text-sm font-medium">
          限时测试
          {recommended !== undefined && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              本单元推荐 {recommended} 分钟
            </span>
          )}
        </span>
        <input
          id={toggleId}
          type="checkbox"
          role="switch"
          aria-checked={value.enabled}
          className="size-5 accent-primary"
          checked={value.enabled}
          onChange={(event) =>
            onChange({ ...value, enabled: event.target.checked })
          }
        />
      </label>
      {value.enabled && (
        <>
          <fieldset className="flex flex-wrap gap-2">
            <legend className="sr-only">选择时长</legend>
            {PRESETS.map((minutes) => {
              const selected =
                value.customText === undefined && value.minutes === minutes;
              return (
                <label
                  key={minutes}
                  className={`flex min-h-10 cursor-pointer items-center rounded-lg border px-3 text-sm has-focus-visible:ring-3 has-focus-visible:ring-ring/50 ${
                    selected
                      ? "border-primary bg-primary/5 font-medium"
                      : "border-border hover:bg-muted/40"
                  }`}
                >
                  <input
                    className="sr-only"
                    type="radio"
                    name={toggleId}
                    value={minutes}
                    checked={selected}
                    onChange={() => onChange({ enabled: true, minutes })}
                  />
                  {minutes} 分钟
                </label>
              );
            })}
            <label
              htmlFor={customId}
              className="flex min-h-10 items-center gap-2 text-sm"
            >
              <span>自定义</span>
              <Input
                id={customId}
                type="number"
                inputMode="numeric"
                min={1}
                max={ATTEMPT_TIME_LIMIT_MINUTES_MAX}
                step={1}
                value={value.customText ?? ""}
                onChange={(event) =>
                  onChange({ ...value, customText: event.target.value })
                }
                className="h-10 w-24"
                aria-label="自定义时长（分钟）"
                aria-invalid={invalid}
                aria-describedby={invalid ? `${customId}-error` : undefined}
              />
              <span className="text-muted-foreground">分钟</span>
            </label>
          </fieldset>
          {invalid && (
            <p
              id={`${customId}-error`}
              className="text-xs text-destructive"
              role="alert"
            >
              请输入 1–{ATTEMPT_TIME_LIMIT_MINUTES_MAX} 之间的整数分钟。
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            计时以服务端为准，换设备、后台或断网重连后剩余时间一致。到时锁住继续
            作答并保住本机稿，10
            分钟宽限内确认交卷；宽限过后只能按已保存答案交卷。
          </p>
        </>
      )}
    </div>
  );
}
