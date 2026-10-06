/**
 * 草稿层布局（T6R.9，方案 §4.3）：自适应布局计算 + 设备级偏好存储。
 *
 * - 布局三态：auto（按题卡可用宽度自动）/ side（题干 55% + 草稿 45% 分栏）/
 *   below（草稿在题干下方整宽）。auto 的分栏阈值由**两列最低可用宽度**决定
 *   （方案 §4.3「最终阈值由两列最低可用宽度与 gap 决定，1024 viewport 不作为
 *   硬约束」）——纸列下限 400px 的依据是 paper-geometry 换算：格距
 *   NOTE_PAPER_GRID_SPACING_LOGICAL=40 逻辑单位在 400px 纸宽下为 16px，
 *   是横线/格线仍可辨读写的下限；题列下限 440px 为阅读舒适暂定值。
 *   ⚠️ 全部数值为暂定值（T6R.1 真机定标后修订）。
 * - 显式偏好（side/below）恒按用户选择生效：side 在窄容器不回退（用户自担，
 *   笔迹逻辑坐标不因纸窄被裁切——paper-geometry 口径）；「窄容器从侧栏
 *   回退 below」只发生在 auto 档（容器变窄 → below）。
 * - 偏好是**设备级**（localStorage，与 T6R.7 输入偏好的会话级不同——布局是
 *   设备形态偏好：同一台 iPad 横竖屏切换不改偏好，只改生效布局）。读写
 *   全部防御式：localStorage 抛错（隐私模式/损坏）或值非法时回退 auto，
 *   不白屏（任务清单失败测试之一）；写入失败静默保留内存值。
 * - 偏好多画布共享：模块级状态 + 订阅（形态同 features/ink/input-preference），
 *   多个题卡的草稿层（含布局切换菜单）即时同步。
 */
import { useEffect, useRef, useState } from "react";
import { NOTE_PAPER_GRID_SPACING_LOGICAL } from "@/features/ink/engine/paper-style";
import { INK_LOGICAL_WIDTH } from "@/features/ink/engine/types";

// ---------- 布局计算（纯函数） ----------

/** 布局偏好：auto=按宽度；side/below=显式指定 */
export type NoteLayoutPreference = "auto" | "side" | "below";
/** 生效布局（auto 解析后的两态） */
export type EffectiveNoteLayout = "side" | "below";

/** 分栏列间 gap（CSS px；与题卡内边距节奏一致的暂定值） */
export const NOTE_LAYOUT_GAP_CSS_PX = 24;
/** 题干列占比（方案 §4.3 分栏初值 55/45） */
export const NOTE_QUESTION_SHARE = 0.55;
/** 草稿纸列占比 */
export const NOTE_PAPER_SHARE = 0.45;
/** 纸面横线/格线的最小可辨 CSS 间距（px，暂定） */
const NOTE_MIN_GRID_SPACING_CSS_PX = 16;
/**
 * 纸列最低可用宽度（CSS px，暂定）：由 paper-geometry 换算派生——纸面
 * 格距 NOTE_PAPER_GRID_SPACING_LOGICAL（40 逻辑单位）在纸宽 W 下的 CSS 间距
 * 为 fromLogical(W, 40)，取可辨下限 16px 反解 W = 16×1000/40 = 400。
 */
export const NOTE_MIN_PAPER_CSS_PX = Math.ceil(
  (NOTE_MIN_GRID_SPACING_CSS_PX * INK_LOGICAL_WIDTH) /
    NOTE_PAPER_GRID_SPACING_LOGICAL,
);
/** 题干列最低可用宽度（CSS px，暂定）：公式/选项阅读舒适下限 */
export const NOTE_MIN_QUESTION_CSS_PX = 440;

/**
 * 题卡宽度是否够两列（55/45 − 半 gap 各自达标）。零宽/负宽（容器未布局/
 * 观察未就绪）不判 side——首帧宁取 below，观察就绪后自然纠正。
 */
export function noteSideUsable(containerCssWidth: number): boolean {
  if (!(containerCssWidth > 0)) return false;
  const halfGap = NOTE_LAYOUT_GAP_CSS_PX / 2;
  return (
    containerCssWidth * NOTE_PAPER_SHARE - halfGap >= NOTE_MIN_PAPER_CSS_PX &&
    containerCssWidth * NOTE_QUESTION_SHARE - halfGap >=
      NOTE_MIN_QUESTION_CSS_PX
  );
}

/**
 * 生效布局：below 恒 below；side 恒 side（显式偏好不回退，见文件头）；
 * auto 按两列最低可用宽度判定（窄容器从侧栏回退 below）。
 */
export function effectiveNoteLayout(
  pref: NoteLayoutPreference,
  containerCssWidth: number,
): EffectiveNoteLayout {
  if (pref === "below") return "below";
  if (pref === "side") return "side";
  return noteSideUsable(containerCssWidth) ? "side" : "below";
}

// ---------- 设备级偏好存储（防御式 localStorage） ----------

/** 偏好持久化键（设备级，与部署实例同源隔离由 origin 天然保证） */
export const NOTE_LAYOUT_STORAGE_KEY = "tutor-note-layout";

const LAYOUT_PREFS: readonly NoteLayoutPreference[] = ["auto", "side", "below"];

/** 读存储并收窄（非法/缺失回退 auto）；localStorage 抛错同样回退 */
function readStored(): NoteLayoutPreference {
  try {
    const raw = window.localStorage.getItem(NOTE_LAYOUT_STORAGE_KEY);
    return LAYOUT_PREFS.includes(raw as NoteLayoutPreference)
      ? (raw as NoteLayoutPreference)
      : "auto";
  } catch {
    return "auto"; // 隐私模式/存储损坏：不白屏，静默回退
  }
}

let current: NoteLayoutPreference = readStored();
const listeners = new Set<(next: NoteLayoutPreference) => void>();

/** 当前布局偏好（缺省 auto） */
export function getNoteLayoutPreference(): NoteLayoutPreference {
  return current;
}

/** 切换偏好：写 localStorage（失败静默——内存值仍生效）并通知订阅者（同值幂等） */
export function setNoteLayoutPreference(next: NoteLayoutPreference): void {
  if (next === current) return;
  current = next;
  try {
    window.localStorage.setItem(NOTE_LAYOUT_STORAGE_KEY, next);
  } catch {
    // 写入失败（隐私模式/配额）：不阻断切换，本次会话内仍生效
  }
  for (const cb of [...listeners]) cb(next);
}

/** 订阅偏好变化（返回取消函数；多个草稿层/菜单共用同一状态） */
export function onNoteLayoutPreferenceChange(
  cb: (next: NoteLayoutPreference) => void,
): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 仅测试使用：复位内存与存储（生产不调用） */
export function resetNoteLayoutForTest(): void {
  current = "auto";
  try {
    window.localStorage.removeItem(NOTE_LAYOUT_STORAGE_KEY);
  } catch {
    // 同上：存储不可用不阻断
  }
}

// ---------- React hook ----------

/** 订阅式读取布局偏好（多画布同源；setNoteLayoutPreference 即更新入口） */
export function useNoteLayoutPreference(): NoteLayoutPreference {
  const [pref, setPref] = useState<NoteLayoutPreference>(current);
  useEffect(() => onNoteLayoutPreferenceChange(setPref), []);
  return pref;
}

/**
 * 观察元素 CSS 宽度（布局判定与纸高换算的数据源）。
 * ResizeObserver 存在时跟随容器尺寸变化（横竖屏/分屏/侧栏回退的驱动源）；
 * 不存在（jsdom）或未就绪时回退 offsetWidth 读数一次。零宽首帧由
 * noteSideUsable 的护栏兜住（判 below），观察回调后自然纠正。
 */
export function useObservedCssWidth(
  ref: React.RefObject<HTMLElement | null>,
): number {
  const [width, setWidth] = useState(0);
  // 回调经 ref 存放：ResizeObserver 只建一次，回调读最新 setter
  const setRef = useRef(setWidth);
  setRef.current = setWidth;
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (typeof ResizeObserver === "undefined") {
      setRef.current(el.offsetWidth); // jsdom/极老浏览器：一次性读数
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setRef.current(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}
