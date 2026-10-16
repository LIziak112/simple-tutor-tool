/**
 * B19 平台留痕核对（SAI-34；手动工具，不进 CI）。
 *
 * 用途：三通道（页内/MCP/链接）真实验证后，在部署本机对 DATA_DIR 只读核对
 * 「平台侧留痕」与用户在外部实际观察到的行为是否对得上：任务状态/代际/失败
 * 摘要、消息时间线、append-only 事实序列、票据读取计数。断言只覆盖结构性
 * 不变量（列与事实同事务落库的成对关系），不推断教学结论。
 *
 * 用法（apps/server 目录下）：
 *   node node_modules/tsx/dist/cli.mjs scripts/b19-verify/trace-audit.ts \
 *     --data-dir <部署 DATA_DIR> [--task <id>…|--student <id>|--attempt <id>|--latest N]
 *   缺省 --latest 10。
 *
 * 核对项（每条对应服务端一个真实的同事务成对写入点）：
 * - 每任务有 task_created 事实（创建事务）；
 * - replied ⟹ 有 reply_received（回信写回事务）；
 * - reply_delivered_at 列 ⟺ reply_delivered 事实（markReplyDelivered 同事务）；
 * - 已开始出站 ⟹ generation ≥ 1：inapp 的 replied/failed/uncertain（begin
 *   CAS 自增）、mcp 的 claimed/replied（claim 事务自增）；
 * - dispatched 事实 ⟹ generation ≥ 1，且 mcp 任务 claimed/replied ⟹ 有
 *   dispatched（claim 单事务同写两者，回信必经领取）。注意 inapp 失败/超时
 *   收敛 failed/uncertain 时**不写** dispatched——beginInappDispatch 只做 CAS
 *   不落事实，出站结果未知不能断言已外发（SAI-14 审计口径）；
 * - 票据行数 = link_generated 事实数（createAiShareTicket 同事务成对）。
 *   任务创建与票据生成是两步——link 任务停在 created 等学生生成链接、或
 *   生成请求失败后未重试，都是合法态，不按通道强判；
 * - 票据 viewCount 合计 = link_viewed 事实数（recordShareTicketViewed 同事务
 *   逐次成对；重新生成新票据后各票计数合计仍与事实总数一致）；
 * - failed ⟹ errorText 非空。
 */
import {
  argList,
  argOf,
  type Finding,
  finishReport,
  openReadonlyDb,
  parseScriptArgs,
} from "./common.ts";

/** ai_tasks 行的脚本侧形态（CLI 从 raw sqlite 映射；测试从合成世界构造） */
export interface TraceTaskRow {
  readonly id: string;
  readonly studentId: string;
  readonly attemptId: string;
  readonly questionId: string;
  readonly channel: string;
  readonly modeAtSend: string;
  readonly status: string;
  readonly generation: number;
  readonly errorText: string | null;
  readonly retryCount: number;
  readonly replyDeliveredAt: string | null;
  readonly cancelRequestedAt: string | null;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TraceMessageRow {
  readonly taskId: string;
  readonly role: string;
  readonly contentMd: string;
  readonly createdAt: string;
}

export interface TraceFactRow {
  readonly taskId: string;
  readonly type: string;
  readonly detailJson: string | null;
  readonly serverTs: string;
}

export interface TraceTicketRow {
  readonly taskId: string;
  readonly viewCount: number;
  readonly lastViewedAt: string | null;
  readonly revokedAt: string | null;
  readonly expiresAt: string;
}

export interface TraceAuditInput {
  readonly tasks: readonly TraceTaskRow[];
  readonly messages: readonly TraceMessageRow[];
  readonly facts: readonly TraceFactRow[];
  readonly tickets: readonly TraceTicketRow[];
}

export interface TraceAuditReport {
  /** 人类可读时间线（打印用） */
  readonly lines: string[];
  readonly findings: Finding[];
}

/** 消息摘要（时间线一行；长文只取首行前 40 字） */
function messageBrief(contentMd: string): string {
  const firstLine = contentMd.split("\n")[0] ?? "";
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
}

/**
 * 审计一批任务的留痕一致性。只读输入、不打印——CLI 与测试共用。时间线行
 * 含任务概要、消息序列、事实序列与票据摘要，供用户与外部实际行为对账。
 */
export function auditTrace(input: TraceAuditInput): TraceAuditReport {
  const findings: Finding[] = [];
  const lines: string[] = [];
  const factsByTask = new Map<string, TraceFactRow[]>();
  for (const fact of input.facts) {
    const bucket = factsByTask.get(fact.taskId) ?? [];
    bucket.push(fact);
    factsByTask.set(fact.taskId, bucket);
  }
  const messagesByTask = new Map<string, TraceMessageRow[]>();
  for (const message of input.messages) {
    const bucket = messagesByTask.get(message.taskId) ?? [];
    bucket.push(message);
    messagesByTask.set(message.taskId, bucket);
  }
  const ticketsByTask = new Map<string, TraceTicketRow[]>();
  for (const ticket of input.tickets) {
    const bucket = ticketsByTask.get(ticket.taskId) ?? [];
    bucket.push(ticket);
    ticketsByTask.set(ticket.taskId, bucket);
  }

  for (const task of input.tasks) {
    const shortId = task.id.slice(0, 8);
    const facts = factsByTask.get(task.id) ?? [];
    const messages = messagesByTask.get(task.id) ?? [];
    const tickets = ticketsByTask.get(task.id) ?? [];
    lines.push(
      `任务 ${shortId}… 通道=${task.channel} 状态=${task.status} 模式=${task.modeAtSend} 代际=${task.generation} 题=${task.questionId} 创建=${task.createdAt}`,
    );
    if (task.errorText !== null) lines.push(`  失败摘要：${task.errorText}`);
    if (task.retryCount > 0) lines.push(`  显式重试：${task.retryCount} 次`);
    if (task.cancelRequestedAt !== null)
      lines.push(`  取消请求：${task.cancelRequestedAt}`);
    if (task.archivedAt !== null) lines.push(`  归档：${task.archivedAt}`);
    for (const message of messages) {
      lines.push(
        `  消息 ${message.role} 「${messageBrief(message.contentMd)}」 @${message.createdAt}`,
      );
    }
    // 事实序列按类型聚合计数（时间线对账用；顺序保持 serverTs 升序的输入序）
    const factCounts = new Map<string, number>();
    for (const fact of facts) {
      factCounts.set(fact.type, (factCounts.get(fact.type) ?? 0) + 1);
    }
    const sequence = facts
      .map((fact) => `${fact.type}@${fact.serverTs}`)
      .join(" → ");
    lines.push(`  事实：${sequence}`);
    const countText = [...factCounts.entries()]
      .map(([type, n]) => `${type} ×${n}`)
      .join("、");
    lines.push(`  事实计数：${countText}`);
    for (const ticket of tickets) {
      lines.push(
        `  票据：读取 ${ticket.viewCount} 次，到期 ${ticket.expiresAt}${ticket.revokedAt === null ? "" : `，已撤销 ${ticket.revokedAt}`}`,
      );
    }

    // —— 结构性不变量（每条对应一个同事务成对写入点） ——
    if (!factCounts.has("task_created")) {
      findings.push({
        level: "fail",
        message: `任务 ${shortId} 缺少 task_created 事实（创建留痕被破坏）`,
      });
    }
    if (task.status === "replied" && !factCounts.has("reply_received")) {
      findings.push({
        level: "fail",
        message: "任务 replied 但无 reply_received 事实（回信留痕被破坏）",
      });
    }
    if (task.replyDeliveredAt === null && factCounts.has("reply_delivered")) {
      findings.push({
        level: "fail",
        message:
          "任务有 reply_delivered 事实但 reply_delivered_at 列为空（列与事实不对账）",
      });
    }
    if (task.replyDeliveredAt !== null && !factCounts.has("reply_delivered")) {
      findings.push({
        level: "fail",
        message: `任务 ${shortId} reply_delivered_at 非空但无 reply_delivered 事实（列与事实不对账）`,
      });
    }
    const outboundStarted =
      (task.channel === "inapp" &&
        (task.status === "replied" ||
          task.status === "failed" ||
          task.status === "uncertain")) ||
      (task.channel === "mcp" &&
        (task.status === "claimed" || task.status === "replied"));
    if (outboundStarted && task.generation === 0) {
      findings.push({
        level: "fail",
        message: "任务已开始出站（回信/失败/待确认/已领取）但 generation=0",
      });
    }
    if (factCounts.has("dispatched") && task.generation < 1) {
      findings.push({
        level: "fail",
        message: `任务 ${shortId} 有 dispatched 事实但 generation=0（代际与出站留痕不对账）`,
      });
    }
    if (
      task.channel === "mcp" &&
      (task.status === "claimed" || task.status === "replied") &&
      !factCounts.has("dispatched")
    ) {
      findings.push({
        level: "fail",
        message: `任务 ${shortId} MCP 任务 claimed/replied 但无 dispatched 事实（领取留痕被破坏）`,
      });
    }
    const linkGenerated = factCounts.get("link_generated") ?? 0;
    if (linkGenerated !== tickets.length) {
      findings.push({
        level: "fail",
        message: `票据行 ${tickets.length} 与 link_generated 事实数 ${linkGenerated} 不成对（票据留痕被破坏）`,
      });
    }
    const viewedFacts = factCounts.get("link_viewed") ?? 0;
    const viewedSum = tickets.reduce(
      (sum, ticket) => sum + ticket.viewCount,
      0,
    );
    if (viewedSum !== viewedFacts) {
      findings.push({
        level: "fail",
        message: `票据读取计数合计 ${viewedSum} 与 link_viewed 事实数 ${viewedFacts} 不符（读取留痕被破坏）`,
      });
    }
    if (
      task.status === "failed" &&
      (task.errorText === null || task.errorText === "")
    ) {
      findings.push({
        level: "fail",
        message: "任务 failed 但 errorText 为空（失败摘要缺失）",
      });
    }
  }
  return { lines, findings };
}

/** CLI 入口：选任务 → 读行 → 审计 → 打印时间线与发现 */
async function main(): Promise<void> {
  const args = parseScriptArgs(process.argv.slice(2));
  const dataDir = argOf(args, "data-dir");
  if (dataDir === undefined) {
    console.error(
      "用法：--data-dir <部署 DATA_DIR> 必填；可选 --task <id>（可重复）/ --student <id> / --attempt <id> / --latest N（默认 10）",
    );
    process.exitCode = 2;
    return;
  }
  const db = openReadonlyDb(dataDir);
  const taskIds = argList(args, "task");
  const studentId = argOf(args, "student");
  const attemptId = argOf(args, "attempt");
  const latest = Number.parseInt(argOf(args, "latest") ?? "10", 10);

  const taskFilter =
    taskIds.length > 0
      ? { sql: `id IN (${taskIds.map(() => "?").join(",")})`, params: taskIds }
      : studentId !== undefined
        ? { sql: "student_id = ?", params: [studentId] }
        : attemptId !== undefined
          ? { sql: "attempt_id = ?", params: [attemptId] }
          : { sql: "", params: [] };
  const tasks = (
    taskFilter.params.length > 0
      ? db
          .prepare(
            `SELECT id, student_id, attempt_id, question_id, channel, mode_at_send, status, generation,
                    error_text, retry_count, reply_delivered_at, cancel_requested_at, archived_at, created_at, updated_at
             FROM ai_tasks WHERE ${taskFilter.sql} ORDER BY created_at DESC, id DESC`,
          )
          .all(...taskFilter.params)
      : db
          .prepare(
            `SELECT id, student_id, attempt_id, question_id, channel, mode_at_send, status, generation,
                    error_text, retry_count, reply_delivered_at, cancel_requested_at, archived_at, created_at, updated_at
             FROM ai_tasks ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .all(Number.isInteger(latest) && latest > 0 ? latest : 10)
  ) as Array<Record<string, string | number | null>>;
  if (tasks.length === 0) {
    console.log(
      "未找到任务行：确认筛选条件（--task/--student/--attempt）或任务确实已创建",
    );
    return;
  }
  const ids = tasks.map((row) => String(row.id));
  const placeholders = ids.map(() => "?").join(",");
  const readAll = <T>(sql: string): T[] => db.prepare(sql).all(...ids) as T[];
  const messages = readAll<Record<string, string>>(
    `SELECT task_id, role, content_md, created_at FROM ai_messages WHERE task_id IN (${placeholders}) ORDER BY created_at`,
  );
  const facts = readAll<Record<string, string | null>>(
    `SELECT task_id, type, detail_json, server_ts FROM ai_facts WHERE task_id IN (${placeholders}) ORDER BY server_ts`,
  );
  const tickets = readAll<Record<string, string | number | null>>(
    `SELECT task_id, view_count, last_viewed_at, revoked_at, expires_at FROM ai_share_tickets WHERE task_id IN (${placeholders})`,
  );

  const input: TraceAuditInput = {
    tasks: tasks.map((row) => ({
      id: String(row.id),
      studentId: String(row.student_id),
      attemptId: String(row.attempt_id),
      questionId: String(row.question_id),
      channel: String(row.channel),
      modeAtSend: String(row.mode_at_send),
      status: String(row.status),
      generation: Number(row.generation),
      errorText: row.error_text === null ? null : String(row.error_text),
      retryCount: Number(row.retry_count),
      replyDeliveredAt:
        row.reply_delivered_at === null ? null : String(row.reply_delivered_at),
      cancelRequestedAt:
        row.cancel_requested_at === null
          ? null
          : String(row.cancel_requested_at),
      archivedAt: row.archived_at === null ? null : String(row.archived_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    })),
    messages: messages.map((row) => ({
      taskId: String(row.task_id),
      role: String(row.role),
      contentMd: String(row.content_md),
      createdAt: String(row.created_at),
    })),
    facts: facts.map((row) => ({
      taskId: String(row.task_id),
      type: String(row.type),
      detailJson: row.detail_json ?? null,
      serverTs: String(row.server_ts),
    })),
    tickets: tickets.map((row) => ({
      taskId: String(row.task_id),
      viewCount: Number(row.view_count),
      lastViewedAt:
        row.last_viewed_at === null ? null : String(row.last_viewed_at),
      revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
      expiresAt: String(row.expires_at),
    })),
  };
  const report = auditTrace(input);
  for (const line of report.lines) console.log(line);
  console.log("");
  finishReport("trace-audit", report.findings);
}

// 仅作为脚本直接运行时执行 CLI（vitest 导入时不执行）
if (process.env.VITEST === undefined) {
  await main();
}
