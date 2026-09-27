/**
 * 每题有效用时与改答案次数的服务端计算（T2.10 核心纯函数，§5.5）：
 * 「每题有效用时由服务端根据 focus/blur/hidden 事件计算，不信任客户端的汇总值」。
 *
 * 事件序列来源：events 表按 clientTs 升序的行（交卷时一次性读取），
 * 计算只依赖每行的 type / clientTs / questionId 三列，不解析 payloadJson。
 *
 * ── 时间规则（与 active-time.test.ts 逐条锁定）────────────────────────────
 * 1. question_focus(q) 起计时；question_blur(q) 停止并结算该段；
 * 2. 焦点期间 page_hidden → 停止累计；page_visible → 恢复累计
 *    （hidden → visible 的区间不计时，验收项）；
 * 3. hidden 之后没有 visible 就 blur / submit / 序列结束 → 只计到 hidden 时刻
 *    （「blur 缺失由 hidden 兜底」）；
 * 4. 跨题 focus：focus(q2) 隐式结算 q1（按事件顺序，等价 blur(q1)@此刻）；
 * 5. 重复 focus 同一题：忽略（不重置起点、不重复计时）；同题再次 focus（中间
 *    blur 过）则新开一段，与旧段累计相加（毫秒总账跨段保留）；
 * 6. submit：结算当前焦点段并停止处理后续事件（交卷后迟到的 blur/focus 不再累计）；
 * 7. 序列结束仍聚焦（无 blur/submit）：计到最后一个事件的 clientTs（兜底，
 *    正常链路前端会在交卷请求前补发 submit 事件）；
 * 8. 每题把累计毫秒一次性四舍五入到秒（Math.round(ms/1000)；毫秒级短段不逐段取整，
 *    避免误差累积；0.5s 进位、0.4s 舍去）。
 *
 * ── changeCount 口径 ────────────────────────────────────────────────────
 * answer_change 事件逐条计数（submit 之后到达的不计）。与 T2.6 草稿 PUT 计数的
 * 统一在 attempt-service 交卷时取 max（见 submitAttempt：事件为权威、草稿计数兜底）。
 */

/** 时间计算所需的最小事件投影（events 表行可直接映射；也接受契约 LearningEvent） */
export interface TimelineEvent {
  readonly type: string;
  readonly clientTs: number;
  readonly questionId?: string | null;
}

/** 当前焦点：题目 + 本段恢复计时的时间点（null = 处于 hidden 停计状态） */
interface CurrentFocus {
  questionId: string;
  /** 当前计时段起点；page_hidden 期间为 null（该段已并入总账） */
  resumedAt: number | null;
}

/**
 * 按事件序列计算每题有效用时（秒）。
 * 输入乱序时先按 clientTs 稳定排序；未知事件类型 / 缺 questionId 的焦点事件
 * 一律忽略（优雅降级，不让脏数据打挂交卷）。只有被聚焦过的题出现在结果里
 * （含聚焦 0 秒的题）。
 */
export function computePerQuestionActiveSec(
  events: readonly TimelineEvent[],
): Record<string, number> {
  const ordered = [...events].sort((a, b) => a.clientTs - b.clientTs);
  /** 每题累计毫秒总账（跨段保留；输出前统一取整） */
  const totalMs: Record<string, number> = {};
  let current: CurrentFocus | null = null;
  let hiddenAt: number | null = null;
  /** 序列最后一个事件的时刻（规则 7 的兜底终点） */
  let lastTs: number | null = null;

  /** 把 current 的进行段结算到 at 时刻并入总账（hidden/未恢复时不加） */
  const settle = (at: number): void => {
    if (current === null || current.resumedAt === null) return;
    totalMs[current.questionId] =
      (totalMs[current.questionId] ?? 0) + (at - current.resumedAt);
    current.resumedAt = null;
  };

  for (const event of ordered) {
    lastTs = event.clientTs;
    switch (event.type) {
      case "question_focus": {
        const questionId = event.questionId;
        if (questionId === undefined || questionId === null) break;
        if (current !== null && current.questionId === questionId) break; // 规则 5
        settle(event.clientTs); // 规则 4：隐式结算前一题
        totalMs[questionId] ??= 0; // 聚焦过即出现（含 0 秒）
        current = {
          questionId,
          // 页面处于 hidden 时新焦点不立即计时（规则 2/3）
          resumedAt: hiddenAt === null ? event.clientTs : null,
        };
        break;
      }
      case "question_blur": {
        const questionId = event.questionId;
        if (current === null || questionId === undefined || questionId === null)
          break;
        if (current.questionId !== questionId) break; // 非当前题的 blur：忽略
        settle(event.clientTs);
        current = null;
        break;
      }
      case "page_hidden": {
        if (hiddenAt !== null) break; // 重复 hidden：忽略
        settle(event.clientTs); // 进行段收进总账（规则 2/3）
        hiddenAt = event.clientTs;
        break;
      }
      case "page_visible": {
        if (hiddenAt === null) break; // 孤立 visible：忽略
        hiddenAt = null;
        if (current !== null) current.resumedAt = event.clientTs;
        break;
      }
      case "submit": {
        settle(event.clientTs); // 规则 6：结算并停止处理后续事件
        return roundAll(totalMs);
      }
      default:
        break; // attempt_start/question_view/answer_change/未知类型：不参与计时
    }
  }
  // 规则 7：序列结束仍聚焦 → 计到最后一个事件时刻（hidden 中则保持已结算值）
  if (current !== null && lastTs !== null) settle(lastTs);
  return roundAll(totalMs);
}

/** 毫秒总账 → 秒（规则 8：整题累计后一次性四舍五入） */
function roundAll(totalMs: Record<string, number>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [questionId, ms] of Object.entries(totalMs)) {
    result[questionId] = Math.round(ms / 1000);
  }
  return result;
}

/**
 * 按题统计 answer_change 事件条数（改答案次数的事件口径）。
 * submit 之后到达的不计（与时间计算同一截止语义）；缺 questionId 的忽略。
 */
export function countAnswerChanges(
  events: readonly TimelineEvent[],
): Record<string, number> {
  const ordered = [...events].sort((a, b) => a.clientTs - b.clientTs);
  const result: Record<string, number> = {};
  for (const event of ordered) {
    if (event.type === "submit") return result;
    if (event.type !== "answer_change") continue;
    const questionId = event.questionId;
    if (questionId === undefined || questionId === null) continue;
    result[questionId] = (result[questionId] ?? 0) + 1;
  }
  return result;
}
