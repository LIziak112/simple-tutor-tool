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
 * - 生效布局按**量化布尔**（noteSideUsable 的结论）解析（复审④）：宽度观察
 *   只在跨阈值翻转时 setState——旋转/分屏拖动不再每帧整卡重渲染；显式偏好
 *   （side/below）不观察宽度。
 * - 显式偏好恒按用户选择生效：side 在窄容器不回退（用户自担，笔迹逻辑坐标
 *   不因纸窄被裁切——paper-geometry 口径）；「窄容器从侧栏回退 below」只发
 *   生在 auto 档。
 * - 偏好是**设备级**（localStorage，与 T6R.7 输入偏好的会话级不同——布局是
 *   设备形态偏好：同一台 iPad 横竖屏切换不改偏好，只改生效布局）。读写
 *   全部防御式：localStorage 抛错（隐私模式/损坏）或值非法时回退 auto，
 *   不白屏（任务清单失败测试之一）；写入失败静默保留内存值。
 * - 偏好多画布共享：createExternalPrefStore 工厂（lib，与 input-preference
 *   同骨架——复审⑩收敛）+ 订阅，多个题卡的草稿层（含布局切换菜单）即时同步。
 * - 渲染侧常量（复审⑨）：分栏比例/列宽/间距以导出常量与样式对象下发题卡
 *   渲染——真机定标改常量时，阈值与渲染不再漂移（配对锁定测试见本文件）。
 */
import type { CSSProperties } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { NOTE_PAPER_GRID_SPACING_LOGICAL } from "@/features/ink/engine/paper-style";
import { INK_LOGICAL_WIDTH } from "@/features/ink/engine/types";
import { createExternalPrefStore } from "@/lib/create-external-pref-store";

// ---------- 布局计算（纯函数） ----------

/** 布局偏好：auto=按宽度；side/below=显式指定 */
export type NoteLayoutPreference = "auto" | "side" | "below";
/** 生效布局（auto 解析后的两态） */
export type EffectiveNoteLayout = "side" | "below";

/** 分栏列间 gap（CSS px；与题卡内边距节奏一致的暂定值） */
export const NOTE_LAYOUT_GAP_CSS_PX = 24;
/** below 形态题干与草稿的纵向间距（题卡内 gap-4 的等价值，暂定） */
export const NOTE_STACK_GAP_CSS_PX = 16;
/** 题干列占比（方案 §4.3 分栏初值 55/45） */
export const NOTE_QUESTION_SHARE = 0.55;
/** 草稿纸列占比 */
export const NOTE_PAPER_SHARE = 0.45;

/** 纸面横线/格线的最小可辨 CSS 间距（px，暂定） */
const NOTE_MIN_GRID_SPACING_CSS_PX = 16;
/**
 * 纸列最低可用宽度（CSS px，暂定）：由 paper-geometry 换算派生——纸面
 * 格距 NOTE_PAPER_GRID_SPACING_LOGICAL（40 逻辑单位）在纸宽 W 下的 CSS 间距
 * 为 W/1000×40，取可辨下限 16px 反解 W = 16×1000/40 = 400。
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
 * 生效布局（量化布尔口径，复审④）：below 恒 below；side 恒 side（显式偏好
 * 不回退，见文件头）；auto 按两列最低可用宽度判定（窄容器从侧栏回退 below）。
 * @param sideUsable noteSideUsable 的结论（观察量化后传入）
 */
export function effectiveNoteLayout(
  pref: NoteLayoutPreference,
  sideUsable: boolean,
): EffectiveNoteLayout {
  if (pref === "below") return "below";
  if (pref === "side") return "side";
  return sideUsable ? "side" : "below";
}

// ---------- 渲染侧常量（复审⑨：阈值与渲染同源） ----------

/** 双列容器（side）样式：行向、顶对齐、gap 同阈值常量 */
export const NOTE_SIDE_ROW_STYLE: CSSProperties = {
  flexDirection: "row",
  alignItems: "flex-start",
  gap: NOTE_LAYOUT_GAP_CSS_PX,
};
/** 上下堆叠容器（below）样式：列向、纵向间距 */
export const NOTE_STACK_ROW_STYLE: CSSProperties = {
  flexDirection: "column",
  gap: NOTE_STACK_GAP_CSS_PX,
};
/** side 的题干列宽（55% 派生自占比常量） */
export const NOTE_QUESTION_COLUMN_STYLE: CSSProperties = {
  width: `${NOTE_QUESTION_SHARE * 100}%`,
};
/** side 的草稿列（吃余宽，防溢出） */
export const NOTE_PAPER_COLUMN_STYLE: CSSProperties = {
  flex: "1 1 0%",
  minWidth: 0,
};

// ---------- 设备级偏好存储（防御式 localStorage + 共享工厂） ----------

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

const prefStore = createExternalPrefStore<NoteLayoutPreference>(readStored());

/** 当前布局偏好（缺省 auto） */
export function getNoteLayoutPreference(): NoteLayoutPreference {
  return prefStore.get();
}

/** 切换偏好：写 localStorage（失败静默——内存值仍生效）并通知订阅者（同值幂等） */
export function setNoteLayoutPreference(next: NoteLayoutPreference): void {
  prefStore.set(next);
  try {
    window.localStorage.setItem(NOTE_LAYOUT_STORAGE_KEY, next);
  } catch {
    // 写入失败（隐私模式/配额）：不阻断切换，本次会话内仍生效
  }
}

/** 订阅偏好变化（返回取消函数；多个草稿层/菜单共用同一状态） */
export function onNoteLayoutPreferenceChange(
  cb: (next: NoteLayoutPreference) => void,
): () => void {
  return prefStore.subscribe(cb);
}

/** 仅测试使用：复位内存与存储（生产不调用） */
export function resetNoteLayoutForTest(): void {
  prefStore.set("auto");
  try {
    window.localStorage.removeItem(NOTE_LAYOUT_STORAGE_KEY);
  } catch {
    // 同上：存储不可用不阻断
  }
}

// ---------- React hook ----------

/** 订阅式读取布局偏好（useSyncExternalStore；setNoteLayoutPreference 即更新入口） */
export function useNoteLayoutPreference(): NoteLayoutPreference {
  return useSyncExternalStore(
    onNoteLayoutPreferenceChange,
    getNoteLayoutPreference,
  );
}

/**
 * 量化分栏判定（复审④）：观察容器宽度但**只在 noteSideUsable 结论翻转时**
 * setState——旋转/分屏拖动的逐帧回调不再引发整卡重渲染。enabled=false
 * （显式 side/below 偏好）不订阅观察（jsdom 回退读 offsetWidth 一次）。
 */
export function useNoteSideUsable(
  ref: React.RefObject<HTMLElement | null>,
  enabled: boolean,
): boolean {
  const [usable, setUsable] = useState(false);
  const setRef = useRef(setUsable);
  setRef.current = setUsable;
  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (el === null) return;
    if (typeof ResizeObserver === "undefined") {
      setRef.current(noteSideUsable(el.offsetWidth));
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const next = noteSideUsable(entries[0]?.contentRect.width ?? 0);
      // 量化：同结论不 setState（引用相等直接返回旧值）
      setUsable((prev) => (prev === next ? prev : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, enabled]);
  return usable;
}
