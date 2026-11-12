import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import {
  ATTEMPT_REVIEW_PARAM,
  attemptReviewTargetOf,
} from "./attempt-review-entry";

/**
 * 整卷复盘浮层（发起 / 进度面板、报告阅读器）与地址、浏览器历史的对应。
 *
 * - 打开 = 地址带上 aiReview。在结果页内打开（此刻没有浮层）时**新增**一条
 *   历史记录并打上标记：浏览器后退 / 手机系统返回手势退掉这一条，就是关闭
 *   浮层、留在结果页原位置。
 * - 面板与报告是同一层：互相切换只替换当前记录，浮层在历史里始终只占一条。
 *   所以后退、关闭按钮、Esc 是同一个结果——回到结果页，不回上一个浮层。
 * - 关闭：当前记录带标记（页内打开的）就后退一步，和返回手势走同一条路，
 *   不留下「关了还要再退一次」或「后退又弹出报告」的记录。不带标记（带参数
 *   直接落地：从求助记录 / 讲练完成页跳来、分享链接）只去掉参数、替换当前
 *   记录；后退仍按浏览器原样回来源页，不拦截。
 * - 标记放在历史记录的 state 里，由浏览器随这条记录保存：刷新后仍在；新开
 *   标签页、别人打开分享链接则没有。
 */

export interface AttemptReviewOverlay {
  /** 当前打开的目标：null = 未打开；"panel" = 面板；其余 = 报告任务 id */
  readonly target: string | null;
  readonly open: (target: string) => void;
  readonly close: () => void;
}

/** 历史记录标记：这一条是在结果页内打开浮层时新增的，后退一步即关闭 */
export const ATTEMPT_REVIEW_LAYER_STATE = { attemptReviewLayer: true } as const;

function openedInPage(state: unknown): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    "attemptReviewLayer" in state &&
    state.attemptReviewLayer === true
  );
}

/** 后退迟迟没有生效时，改为去掉参数的等待时间 */
const CLOSE_FALLBACK_MS = 400;

export function useAttemptReviewOverlay(): AttemptReviewOverlay {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const target = attemptReviewTargetOf(params.get(ATTEMPT_REVIEW_PARAM));
  const inPageLayer = target !== null && openedInPage(location.state);

  // 历史操作要等下一次渲染才反映到 location：这期间的重复触发（双击入口、
  // 连点关闭、连按 Esc）不能再新增或多退一条。记下已经从哪条记录发起过，
  // 换到另一条记录（或卸载）后清掉
  const opened = useRef<string | null>(null);
  const closing = useRef<{ key: string; fallback: number } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: location.key 是「已换到另一条记录」的变更键（effect 体不直接读取）
  useEffect(
    () => () => {
      opened.current = null;
      window.clearTimeout(closing.current?.fallback);
      closing.current = null;
    },
    [location.key],
  );

  const open = useCallback(
    (next: string) => {
      const nextParams = new URLSearchParams(params);
      nextParams.set(ATTEMPT_REVIEW_PARAM, next);
      if (target !== null) {
        // 同层切换：替换当前记录，标记原样带过去（落地的仍无标记）
        setParams(nextParams, {
          replace: true,
          state: location.state,
          preventScrollReset: true,
        });
        return;
      }
      // 页内打开：新增一条带标记的记录；紧接着的重复打开只替换刚加的那条
      setParams(nextParams, {
        replace: opened.current === location.key,
        state: ATTEMPT_REVIEW_LAYER_STATE,
        preventScrollReset: true,
      });
      opened.current = location.key;
    },
    [params, setParams, target, location.state, location.key],
  );

  const removeParam = useCallback(() => {
    const nextParams = new URLSearchParams(params);
    nextParams.delete(ATTEMPT_REVIEW_PARAM);
    setParams(nextParams, { replace: true, preventScrollReset: true });
  }, [params, setParams]);

  const close = useCallback(() => {
    if (!inPageLayer) {
      removeParam();
      return;
    }
    if (closing.current?.key === location.key) return;
    void navigate(-1);
    closing.current = {
      key: location.key,
      // 兜底：标记还在、下面却没有可退的记录（浏览器只恢复了当前这一条）时
      // 后退不会生效——不能让关闭按钮失灵，改为去掉参数
      fallback: window.setTimeout(removeParam, CLOSE_FALLBACK_MS),
    };
  }, [inPageLayer, removeParam, navigate, location.key]);

  return { target, open, close };
}
