import type { AiTeachingMode } from "@tutor/contract";
import { aiContextSnapshotSchema } from "@tutor/contract";
import { eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import type { Db } from "../db/client.ts";
import { responses } from "../db/schema.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  AI_MATERIAL_KIND_LABELS,
  aiMaterialFileReady,
  loadAiTaskMaterialRows,
  readMaterialBytes,
} from "../services/ai-companion/student-ai-materials.ts";
import {
  firstQuestionOf,
  questionNoByQuestionOf,
} from "../services/ai-companion/student-ai-queue.ts";
import {
  type ResolvedShareTicket,
  recordShareTicketViewed,
  requireShareTicketByToken,
} from "../services/ai-companion/student-ai-share.ts";

/**
 * SAI-29 分享正文及附件（B15；需求规格 §10、技术方案 §4.2 公开读表）。
 *
 * 外部 AI 可读的公开端点（无会话，票据即授权），挂在 /api/public/ai/share：
 * - GET/HEAD /:token：单题 HTML 正文——题号/快照时间/有效模式/题干/学生
 *   作答/参考答案/官方解析/学生问题/材料清单。只装配该票据绑定任务的冻结
 *   快照（contextSnapshotJson），绝不从最新题库重拼（旧链接不悄悄指向新稿
 *   由 SAI-28 payloadHash 把关）；
 * - GET/HEAD /:token/materials/:n.png：仅本票据任务已登记材料的 PNG 附件。
 *
 * 安全口径（批次实施步骤逐条）：
 * - 授权答案解析可出现（受控 AI 出口例外，AGENTS.md 唯一授权点）；学生
 *   姓名/内部 UUID/绝对路径/教师私注/邻题材料结构上不进入装配路径；
 * - 正文与每张附件都独立过 requireShareTicketByToken（过期/撤销/禁用/
 *   快照变更后直连图片同样拒绝）；
 * - 响应一律 no-store + no-referrer + noindex, nofollow（HTML 另加 CSP）；
 *   PWA Service Worker 不配置任何 /api 运行时缓存规则，天然不缓存本路径；
 * - HEAD 不记已读；GET 正文实际返回成功才记 link_viewed（source=unknown），
 *   附件读取不记正文已读；缺件在正文明确说明、直连返回 AI_MATERIAL_BROKEN，
 *   不用空白图假成功；
 * - 错误走统一壳（HttpError）：不含 token 明文/快照/文件路径；应用日志的
 *   path 脱敏在 app.ts 统一完成（/api/public/ai/share/[token]）。
 */

/** 分享响应的通用防缓存/防索引/防 Referrer 外泄头（GET 与 HEAD 一致） */
const SHARE_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

/** 票据「不存在」统一文案（与 student-ai-share 服务同文案防枚举） */
const TICKET_NOT_FOUND_MESSAGE = "分享链接不存在或已失效";

/** HTML 正文响应头：在通用头之上加内容类型与 CSP（样式内联，其余全禁） */
const SHARE_HTML_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  ...SHARE_RESPONSE_HEADERS,
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
};

/** 教学模式中文标签（需求规格 §2.3 标准名，与前端 ai-policy-text.ts 同文案） */
const AI_TEACHING_MODE_LABELS: Readonly<Record<AiTeachingMode, string>> = {
  open_study: "开放伴学",
  guided_only: "仅启发",
  post_submit_only: "完成后可用",
};

/** 附件页号形态：仅十进制数字 + .png（穿越/大写/错后缀/负数一律不匹配） */
const MATERIAL_PAGE_PATTERN = /^(\d+)\.png$/;

/** HTML 转义：所有快照/问题文本进页面前过这里（markdown 原文按文本呈现） */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** markdown 源文呈现：转义 + pre-wrap 保留换行（公式原文可用，不解析渲染） */
function mdBlock(markdown: string): string {
  return `<pre class="md">${escapeHtml(markdown)}</pre>`;
}

/** 解析任务冻结快照（契约 schema 单源校验；损坏 = 500 不伪造正文） */
function parseSnapshot(contextSnapshotJson: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(contextSnapshotJson);
  } catch {
    throw new HttpError(
      500,
      "AI_CONTEXT_BROKEN",
      "任务上下文快照损坏，无法生成分享正文",
    );
  }
  const parsed = aiContextSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(
      500,
      "AI_CONTEXT_BROKEN",
      "任务上下文快照损坏，无法生成分享正文",
    );
  }
  return parsed.data;
}

/** 卷内题号（1 起冻结序）：不在卷行（软删/缺失）时返回 null，不伪造题号 */
function shareQuestionNo(
  db: Db,
  attemptId: string,
  questionId: string,
): number | null {
  const rows = db
    .select({
      questionId: responses.questionId,
      unitId: responses.unitId,
    })
    .from(responses)
    .where(eq(responses.attemptId, attemptId))
    .orderBy(sql`rowid`)
    .all();
  return questionNoByQuestionOf(rows).get(questionId) ?? null;
}

/** 材料清单条目（正文渲染用）：链接 URL 只含票据 token 与页序，无内部路径 */
interface ShareMaterialEntry {
  readonly label: string;
  readonly index: number;
  readonly ready: boolean;
  readonly missingText: string | null;
}

function shareMaterialEntries(
  db: Db,
  dataDir: string,
  taskId: string,
): ShareMaterialEntry[] {
  return loadAiTaskMaterialRows(db, taskId).map((row, index) => {
    const label = `${AI_MATERIAL_KIND_LABELS[row.kind]}第 ${row.pageIndex + 1} 页`;
    if (row.state !== "ready") {
      return {
        label,
        index,
        ready: false,
        missingText: "历史材料缺失或未成功上传，无法查看当时快照",
      };
    }
    if (!aiMaterialFileReady(dataDir, row)) {
      return {
        label,
        index,
        ready: false,
        missingText:
          "材料文件缺失，暂时无法查看（可稍后重试或让学生重新生成链接）",
      };
    }
    return { label, index, ready: true, missingText: null };
  });
}

/**
 * 组装单题分享正文 HTML。不落任何内部标识：任务/票据/材料的 UUID、
 * 内部文件路径、学生姓名、教师私注都结构上不在装配输入里。
 */
function buildShareBodyHtml(
  db: Db,
  dataDir: string,
  token: string,
  resolved: ResolvedShareTicket,
): string {
  const { task, ticket } = resolved;
  const snapshot = parseSnapshot(task.contextSnapshotJson);
  const question = firstQuestionOf(db, task.id);
  const questionNo = shareQuestionNo(db, task.attemptId, task.questionId);
  const materials = shareMaterialEntries(db, dataDir, task.id);
  const tokenPath = encodeURIComponent(token);

  const items = materials
    .map((item) =>
      item.ready
        ? `<li><a href="/api/public/ai/share/${tokenPath}/materials/${item.index}.png" rel="nofollow">${escapeHtml(item.label)}（PNG 图片）</a></li>`
        : `<li>${escapeHtml(item.label)}——<span class="missing">缺失：${escapeHtml(item.missingText ?? "材料不可用")}</span></li>`,
    )
    .join("\n");
  const materialsSection =
    materials.length > 0
      ? `<ul class="materials">${items}</ul>`
      : '<p class="missing">本次分享未附带材料。</p>';

  const answerBlock =
    snapshot.referenceAnswerMd !== null
      ? mdBlock(snapshot.referenceAnswerMd)
      : '<p class="missing">本题无固定参考答案。</p>';
  const solutionBlock =
    snapshot.solutionMd !== null
      ? mdBlock(snapshot.solutionMd)
      : '<p class="missing">暂无官方解析。</p>';
  const studentAnswerBlock =
    snapshot.studentAnswerText !== null
      ? mdBlock(snapshot.studentAnswerText)
      : '<p class="missing">求助时尚未作答（或作答为笔迹，无可读文本）。</p>';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>AI 伴学分享 · ${questionNo === null ? "单题" : `第 ${questionNo} 题`}</title>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0 auto; padding: 1.5rem 1rem; max-width: 46rem; line-height: 1.65; }
header { border-bottom: 1px solid rgba(128,128,128,.35); padding-bottom: .75rem; margin-bottom: 1.25rem; }
h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
.meta { font-size: .875rem; opacity: .85; margin: .25rem 0; }
.notice { font-size: .8125rem; opacity: .75; margin-top: .5rem; }
section { margin-bottom: 1.5rem; }
h2 { font-size: 1rem; margin: 0 0 .5rem; }
pre.md { white-space: pre-wrap; overflow-wrap: anywhere; background: rgba(128,128,128,.08); border-radius: .375rem; padding: .75rem; margin: 0; font-family: inherit; }
ul.materials { padding-left: 1.25rem; margin: 0; }
.missing { opacity: .8; }
footer { border-top: 1px solid rgba(128,128,128,.35); margin-top: 2rem; padding-top: .75rem; font-size: .8125rem; opacity: .7; }
</style>
</head>
<body>
<header>
<h1>AI 伴学分享（单题快照）</h1>
<p class="meta">题号：${questionNo === null ? "未知（题目已不在本卷中）" : `第 ${questionNo} 题`}</p>
<p class="meta">快照时间：${escapeHtml(snapshot.capturedAt)}（UTC）</p>
<p class="meta">发送时有效模式：${escapeHtml(AI_TEACHING_MODE_LABELS[task.modeAtSend])}</p>
<p class="meta">链接到期时间：${escapeHtml(ticket.expiresAt)}（UTC）</p>
<p class="notice">获得本链接者可读取本题参考答案、官方解析与选定材料；链接有有效期且可被学生撤销，内容为发送时刻的快照。</p>
</header>
<section>
<h2>题面</h2>
${mdBlock(snapshot.stemMd)}
</section>
<section>
<h2>学生作答（求助时）</h2>
${studentAnswerBlock}
</section>
<section>
<h2>参考答案</h2>
${answerBlock}
</section>
<section>
<h2>官方解析</h2>
${solutionBlock}
</section>
<section>
<h2>学生的问题</h2>
${mdBlock(question)}
</section>
<section>
<h2>材料（仅本题选定附件）</h2>
${materialsSection}
</section>
<footer>本页由学习平台生成，仅供获得链接的 AI 或人员读取本题内容；不缓存、不索引。</footer>
</body>
</html>`;
}

/**
 * 创建分享读路由（无会话，票据即授权）。GET 与 HEAD 共用 handler：
 * 校验、状态码与响应头完全一致；差异只有两点——HEAD 不带 body、
 * GET 正文在实际返回成功前记一次读取（recordShareTicketViewed）。
 */
export function createPublicAiShareRoutes(db: Db, dataDir: string) {
  const serveBody = (c: Context): Response => {
    const token = c.req.param("token");
    if (token === undefined) {
      throw new HttpError(404, "NOT_FOUND", TICKET_NOT_FOUND_MESSAGE);
    }
    const resolved = requireShareTicketByToken(db, token);
    const isHead = c.req.method === "HEAD";
    // HEAD 也完整装配：快照损坏等故障下 GET/HEAD 状态码一致，只差不带 body
    const html = buildShareBodyHtml(db, dataDir, token, resolved);
    if (!isHead) {
      recordShareTicketViewed(db, resolved);
    }
    return new Response(isHead ? null : html, {
      status: 200,
      headers: SHARE_HTML_RESPONSE_HEADERS,
    });
  };
  const serveMaterial = (c: Context): Response => {
    const token = c.req.param("token");
    if (token === undefined) {
      throw new HttpError(404, "NOT_FOUND", TICKET_NOT_FOUND_MESSAGE);
    }
    const resolved = requireShareTicketByToken(db, token);
    // 页号形态 + 边界双重校验：穿越/替换 ID/大写后缀/越界页号一律 404，
    // 不进文件读取（路径单源来自 DB 行，不收客户端路径）
    const match = MATERIAL_PAGE_PATTERN.exec(c.req.param("page") ?? "");
    const index = match === null ? null : Number(match[1]);
    const rows = loadAiTaskMaterialRows(db, resolved.task.id);
    const row =
      index !== null &&
      Number.isSafeInteger(index) &&
      index >= 0 &&
      index < rows.length
        ? rows[index]
        : undefined;
    if (row === undefined) {
      throw new HttpError(404, "NOT_FOUND", "附件不存在或已失效");
    }
    const { bytes } = readMaterialBytes(dataDir, row);
    return new Response(c.req.method === "HEAD" ? null : bytes, {
      status: 200,
      headers: {
        ...SHARE_RESPONSE_HEADERS,
        "content-type": "image/png",
        "content-length": String(bytes.byteLength),
      },
    });
  };
  return new Hono()
    .get("/:token", serveBody)
    .on("HEAD", "/:token", serveBody)
    .get("/:token/materials/:page", serveMaterial)
    .on("HEAD", "/:token/materials/:page", serveMaterial);
}
