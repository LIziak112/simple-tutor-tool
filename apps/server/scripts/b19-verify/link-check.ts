/**
 * B19 上下文链接票据核对（SAI-34；手动工具，不进 CI）。
 *
 * 用途：link 通道任务生成票据 URL 后，用本脚本从「平台之外的视角」拉取
 * 快照正文，核对授权投影完整（七处区块标记：标题 + 六区块）且无内部标识/
 * 私注/他题哨兵；核对过期/撤销/快照变更/不存在的拒绝形态。默认 GET（会
 * 真实记一次 link_viewed——与外部 AI 抓取同链路，对账时计入读取计数）；
 * --head 用 HEAD 预检不记已读。
 *
 * 用法（任意目录，Node 18+ 内置 fetch）：
 *   B19_LINK_URL=<票据URL> node node_modules/tsx/dist/cli.mjs scripts/b19-verify/link-check.ts \
 *     --expect ok|expired|revoked|stale|missing \
 *     [--must-contain <哨兵>…] [--must-not-contain <哨兵>…] [--head] [--fetch-materials]
 *   票据 URL 里的明文 token 是读取授权，优先用 B19_LINK_URL 环境变量传入
 *   （与 mcp-smoke 的密钥纪律一致，不进 shell 历史与进程列表）；--url 参数
 *   仍可用（本地试跑等一次性场景）。
 *
 * 哨兵建议（来自你的合成/匿名世界，勿用真实学生数据）：
 *   --must-contain 题面里的一句独特文字 / 参考答案关键词
 *   --must-not-contain 教师私注原文片段 / 另一题的题干片段 / 学生姓名
 * 注意正文是 HTML 转义后的 markdown 原文呈现，哨兵请选不含 <>&"' 字符的
 * 纯文本片段。expect=ok 之外的模式只核对状态码与拒绝文案。
 */
import {
  argList,
  argOf,
  type Finding,
  finishReport,
  parseScriptArgs,
} from "./common.ts";
import type { SmokeStep } from "./mcp-smoke.ts";

/** 期望形态：ok=正文可读 | expired/revoked/stale=403 拒绝 | missing=404 防探测 */
export type LinkExpectation =
  | "ok"
  | "expired"
  | "revoked"
  | "stale"
  | "missing";

export interface LinkCheckInput {
  readonly url: string;
  readonly expectation: LinkExpectation;
  readonly mustContain: readonly string[];
  readonly mustNotContain: readonly string[];
  readonly method: "GET" | "HEAD";
  readonly fetchMaterials: boolean;
}

export interface LinkCheckReport {
  readonly steps: SmokeStep[];
  readonly findings: Finding[];
  /** 正文里材料附件 anchor 数量（expect=ok 时有意义） */
  readonly materialCount: number;
}

/** 分享正文必备区块（SAI-29 装配结构；缺一即投影不完整） */
const REQUIRED_SECTIONS = [
  "AI 伴学分享（单题快照）",
  "题面",
  "学生作答（求助时）",
  "参考答案",
  "官方解析",
  "学生的问题",
  "材料（仅本题选定附件）",
] as const;

/** UUID 形态（结构上不进正文；出现即视为内部标识泄露面异常） */
const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** 拒绝形态对照：状态码 + 文案关键词（服务端统一错误壳） */
const DENIAL_SPEC: Readonly<
  Record<
    Exclude<LinkExpectation, "ok">,
    { status: number; keyword: string; label: string }
  >
> = {
  expired: { status: 403, keyword: "过期", label: "已过期拒绝" },
  revoked: { status: 403, keyword: "撤销", label: "已撤销拒绝" },
  stale: {
    status: 403,
    keyword: "分享内容已更新",
    label: "快照变更后旧票据拒绝",
  },
  missing: { status: 404, keyword: "不存在或已失效", label: "不存在防探测" },
};

/**
 * 从正文提取材料附件 anchor 的页序（/materials/<n>.png 的 n 去重升序）。
 * 服务端 href 的索引是材料行页号——缺失行不产 anchor，不能按 anchor 数量
 * 顺序拉 0..N-1（会把缺口后面的真实页漏掉、把已知缺失页当异常）。
 */
function materialPageIndexList(html: string): number[] {
  const indexes = new Set<number>();
  for (const match of html.matchAll(/\/materials\/(\d+)\.png/g)) {
    const parsed = Number.parseInt(match[1] ?? "", 10);
    if (Number.isInteger(parsed)) indexes.add(parsed);
  }
  return [...indexes].sort((a, b) => a - b);
}

/**
 * 拉取票据端点并按期望核对。fetchImpl 可注入（测试用 node:http 假端点
 * 自证；CLI 用全局 fetch）。只对票据端点发请求，不携带任何会话凭证。
 */
export async function runLinkCheck(
  input: LinkCheckInput,
  fetchImpl: typeof fetch = fetch,
): Promise<LinkCheckReport> {
  const steps: SmokeStep[] = [];
  const findings: Finding[] = [];
  const url = new URL(input.url);
  const res = await fetchImpl(url, { method: input.method });

  if (input.expectation === "ok") {
    const ok = res.status === 200;
    steps.push({
      name: "HTTP 200",
      ok,
      detail: ok ? "正文端点返回 200" : `期望 200，实际 ${res.status}`,
    });
    const noStore = (res.headers.get("cache-control") ?? "").includes(
      "no-store",
    );
    steps.push({
      name: "防缓存头 no-store",
      ok: noStore,
      detail: noStore
        ? "cache-control 含 no-store"
        : `cache-control 实际为 ${res.headers.get("cache-control") ?? "（空）"}`,
    });
    if (!ok) {
      steps.push({
        name: "正文含全部区块",
        ok: false,
        detail: "端点未返回 200，跳过正文核对",
      });
      steps.push({
        name: "正文无 UUID 形态内部标识",
        ok: false,
        detail: "端点未返回 200，跳过正文核对",
      });
      steps.push({
        name: "必须哨兵在正文",
        ok: false,
        detail: "端点未返回 200，跳过",
      });
      steps.push({
        name: "禁止哨兵不在正文",
        ok: false,
        detail: "端点未返回 200，跳过",
      });
    } else {
      const body = await res.text();
      const missing = REQUIRED_SECTIONS.filter(
        (section) => !body.includes(section),
      );
      steps.push({
        name: "正文含全部区块",
        ok: missing.length === 0,
        detail:
          missing.length === 0
            ? "七处区块标记齐全"
            : `缺少区块：${missing.join("、")}`,
      });
      const uuidHit = UUID_PATTERN.exec(body);
      steps.push({
        name: "正文无 UUID 形态内部标识",
        ok: uuidHit === null,
        detail:
          uuidHit === null
            ? "未检出 UUID 形态字符串"
            : `检出疑似内部标识：${uuidHit[0]}`,
      });
      const absent = input.mustContain.filter(
        (sentinel) => !body.includes(sentinel),
      );
      steps.push({
        name: "必须哨兵在正文",
        ok: absent.length === 0,
        detail:
          absent.length === 0
            ? input.mustContain.length === 0
              ? "（未指定哨兵，跳过）"
              : "全部必须哨兵在正文"
            : `缺失哨兵：${absent.join("、")}`,
      });
      const present = input.mustNotContain.filter((sentinel) =>
        body.includes(sentinel),
      );
      steps.push({
        name: "禁止哨兵不在正文",
        ok: present.length === 0,
        detail:
          present.length === 0
            ? input.mustNotContain.length === 0
              ? "（未指定哨兵，跳过）"
              : "全部禁止哨兵不在正文"
            : `检出禁止哨兵：${present.join("、")}`,
      });
      const pageIndexes = materialPageIndexList(body);
      const materialCount = pageIndexes.length;
      if (input.fetchMaterials && materialCount > 0 && input.method === "GET") {
        // 逐张拉取附件（按 anchor 真实页序；缺件/越权在此暴露）
        const base = `${url.origin}${url.pathname}`;
        let materialsOk = true;
        const details: string[] = [];
        for (const pageIndex of pageIndexes) {
          const materialRes = await fetchImpl(
            `${base}/materials/${pageIndex}.png`,
          );
          const contentType = materialRes.headers.get("content-type") ?? "";
          const good =
            materialRes.status === 200 && contentType.includes("image/png");
          materialsOk = materialsOk && good;
          details.push(
            `第 ${pageIndex + 1} 张 ${materialRes.status}/${contentType || "无类型"}${good ? "" : "（异常）"}`,
          );
        }
        steps.push({
          name: "材料附件可拉取",
          ok: materialsOk,
          detail: details.join("；"),
        });
      }
      for (const step of steps) {
        if (!step.ok)
          findings.push({
            level: "fail",
            message: `${step.name}：${step.detail}`,
          });
      }
      return { steps, findings, materialCount };
    }
  } else {
    const spec = DENIAL_SPEC[input.expectation];
    const body =
      input.method === "HEAD" ? "" : await res.text().catch(() => "");
    const ok =
      res.status === spec.status &&
      (input.method === "HEAD" || body.includes(spec.keyword));
    steps.push({
      name: spec.label,
      ok,
      detail: ok
        ? `HTTP ${res.status} 且文案含「${spec.keyword}」`
        : `期望 HTTP ${spec.status} + 「${spec.keyword}」，实际 ${res.status}，正文片段：${body.slice(0, 120) || "（HEAD 无正文）"}`,
    });
  }
  for (const step of steps) {
    if (!step.ok)
      findings.push({ level: "fail", message: `${step.name}：${step.detail}` });
  }
  return { steps, findings, materialCount: 0 };
}

/** CLI 入口：解析参数（票据 URL 优先取 B19_LINK_URL 环境变量）→ 核对 → 打印与退出码 */
async function main(): Promise<void> {
  const args = parseScriptArgs(process.argv.slice(2));
  const url = argOf(args, "url") ?? process.env.B19_LINK_URL;
  const expect = argOf(args, "expect") ?? "ok";
  if (
    url === undefined ||
    !["ok", "expired", "revoked", "stale", "missing"].includes(expect)
  ) {
    console.error(
      "用法：设 B19_LINK_URL=<票据URL>（推荐，明文 token 不进命令行）或 --url <票据URL>；--expect ok|expired|revoked|stale|missing（默认 ok）；--must-contain / --must-not-contain 哨兵（可重复）；--head 不记已读；--fetch-materials 逐张拉取附件",
    );
    process.exitCode = 2;
    return;
  }
  const report = await runLinkCheck({
    url,
    expectation: expect as LinkExpectation,
    mustContain: argList(args, "must-contain"),
    mustNotContain: argList(args, "must-not-contain"),
    method: args.head === true ? "HEAD" : "GET",
    fetchMaterials: args["fetch-materials"] === true,
  });
  for (const step of report.steps) {
    console.log(`[${step.ok ? "PASS" : "FAIL"}] ${step.name}：${step.detail}`);
  }
  if (expect === "ok") {
    console.log(`材料附件 anchor：${report.materialCount} 张`);
  }
  console.log("");
  finishReport("link-check", report.findings);
}

// 仅作为脚本直接运行时执行 CLI（vitest 导入时不执行）
if (process.env.VITEST === undefined) {
  await main();
}
