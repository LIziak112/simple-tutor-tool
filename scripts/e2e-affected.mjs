// e2e 按功能面标签选测（2026-10-25 第二版，替代首版「仅 spec 变动→跑 spec」的保守版）：
// 开发循环只跑受影响功能面 + 冒烟，且只跑 chromium；webkit 与双浏览器全量留给
// PR CI 闸门与每晚 schedule。决策链（自上而下，命中即止）：
//   1) 命中 affected-lib 兜底清单（依赖锁/各类配置/契约/迁移/scripts 等，见
//      affected-lib.mjs）或本脚本 e2e 兜底（packages/**、apps/server/src/db/**、
//      app.ts、e2e 非 spec 基建如 fake-ai-provider/annotation-assertions）→ 全量
//      （全部用例，仍仅 chromium）；
//   2) 应用源码经显式映射表命中功能面标签（apps/web/src/features/<面> 与
//      apps/server/src/routes/<文件>；.test.ts 视同同名实现文件）→
//      `--grep "@smoke|@x|@y"`；
//   3) apps/ 下未进映射表的源码（features/markdown、features/shared、src/lib、
//      services、vite.config 等）是跨功能面共享 → 全量；映射表不能省也正在此：
//      只有它认识应用源码，Playwright 的 import 图不认识；
//   4) e2e/*.spec.ts 变动 → 该 spec 自身标签并入 grep；未登记的新 spec → 全量；
//   5) 其余变动（docs 等）不贡献标签；无任何命中 → 只跑 @smoke。
// 在 grep 之上再叠加 Playwright 自带 --only-changed=<ref>（它只认 spec/helper 的
// import 图）：先用 --list 试探两者交集非空才叠加——纯应用源码变更时
// --only-changed 会选空（应用源码不在 import 图里），直接叠加会把映射表选出的
// 功能面清零。
//
// 用法：node scripts/e2e-affected.mjs [ref]（默认 v2——本仓库开发循环的基线分支，
// 与 test:affected 的 origin/main 口径不同：v2 长期领先 main，以 main 为基线任何
// 分支都会摊成全量，选测就失效了）。
// 环境变量 AFFECTED_DRY_RUN=1 只打印决策不执行。
import { spawnSync } from "node:child_process";
import {
  collectChangedFiles,
  hitForceFull,
  runIfMain,
  runOrDryRun,
  toCommandLine,
} from "./affected-lib.mjs";

/** 冒烟标签：任何选测结果都包含（三个跨功能面主链 spec，见 SPEC_TAGS） */
export const SMOKE_TAG = "@smoke";

/** 全部功能面标签（打标完整性核对与文档用） */
export const ALL_TAGS = [
  "@smoke",
  "@teacher",
  "@student",
  "@annotation",
  "@ai",
  "@mcp",
  "@export",
  "@insights",
  "@admin",
];

/** e2e/<文件名> → 标签。每个 spec 至少一个；未登记的 spec 变动按全量兜底 */
export const SPEC_TAGS = {
  // 冒烟（任何选测都随基线跑）
  "full-chain.spec.ts": ["@smoke"],
  "student-course-practice.spec.ts": ["@smoke"],
  "password-login.spec.ts": ["@smoke"],
  // 圈画 / 手写 / 草稿纸面 / 橡皮 / 笔记
  "annotation.spec.ts": ["@annotation"],
  "annotation-native-surface.spec.ts": ["@annotation"],
  "annotation-local-base.spec.ts": ["@annotation"],
  "annotation-paper-interaction.spec.ts": ["@annotation"],
  "annotation-cross-device-view.spec.ts": ["@annotation"],
  // 圈画会话新增 spec，合入 v2 后条目即生效（文件暂不在 v2 不影响判定）
  "annotation-pixel-grid.spec.ts": ["@annotation"],
  "question-inline-annotation.spec.ts": ["@annotation"],
  "eraser-position.spec.ts": ["@annotation"],
  "ink-feel.spec.ts": ["@annotation"],
  "ink-lifecycle.spec.ts": ["@annotation"],
  "note-layer.spec.ts": ["@annotation"],
  "note-render.spec.ts": ["@annotation"],
  "note-submit-evidence.spec.ts": ["@annotation"],
  "paper-fullscreen.spec.ts": ["@annotation"],
  // 学生端 AI 伴学
  "student-ai.spec.ts": ["@ai"],
  "student-ai-settings.spec.ts": ["@ai"],
  "student-ai-errors.spec.ts": ["@ai"],
  "student-ai-perf.spec.ts": ["@ai"],
  "student-ai-contexts.spec.ts": ["@ai"],
  // MCP
  "mcp-smoke.spec.ts": ["@mcp"],
  "student-mcp-loop.spec.ts": ["@mcp"],
  // 导出
  "export-wizard.spec.ts": ["@export"],
  "ongoing-question-export.spec.ts": ["@export"],
  "shared-publish-import.spec.ts": ["@export"],
  // 学情
  "insights-pages.spec.ts": ["@insights"],
  "teacher-data-page.spec.ts": ["@insights"],
  "learning-pack-v2.spec.ts": ["@insights", "@export"],
  // 管理端
  "admin-ui.spec.ts": ["@admin"],
  "teacher-register-admin.spec.ts": ["@admin"],
  // 教师端
  "teacher-mark-flow.spec.ts": ["@teacher"],
  "teacher-navigation-settings.spec.ts": ["@teacher"],
  "teaching-pack.spec.ts": ["@teacher"],
  "math-publication.spec.ts": ["@teacher"],
  "capability-profile.spec.ts": ["@teacher"],
  "course-cache.spec.ts": ["@teacher"],
  "multi-teacher-full-chain.spec.ts": ["@teacher"],
  // 学生端
  "student-course.spec.ts": ["@student"],
  "student-lecture-reading.spec.ts": ["@student"],
  "student-settings.spec.ts": ["@student"],
  "student-workspace.spec.ts": ["@student"],
  "student-records.spec.ts": ["@student"],
  "student-review-workspace.spec.ts": ["@student"],
  "student-self-review.spec.ts": ["@student"],
  "wrong-book.spec.ts": ["@student"],
  "wrong-practice.spec.ts": ["@student"],
  "attempt-sync.spec.ts": ["@student"],
  "answer-submit-race.spec.ts": ["@student"],
  "question-card-alignment.spec.ts": ["@student"],
  "question-base.spec.ts": ["@student"],
  "practice-feedback.spec.ts": ["@student"],
  "practice-single-workspace.spec.ts": ["@student"],
  // 跨师生两端
  "lesson.spec.ts": ["@teacher", "@student"],
  "dual-role-session.spec.ts": ["@teacher", "@student"],
  "phase3-full-chain.spec.ts": ["@teacher", "@student"],
};

/** apps/web/src/features/<目录名> → 标签；未列目录（markdown、shared）→ 全量 */
export const FEATURE_DIR_TAGS = {
  admin: ["@admin"],
  annotation: ["@annotation"],
  assignments: ["@teacher", "@student"],
  attempt: ["@student", "@annotation"],
  auth: ["@teacher", "@student"],
  capability: ["@teacher"],
  content: ["@teacher"],
  courses: ["@teacher", "@student"],
  export: ["@export"],
  ink: ["@annotation"],
  insights: ["@insights"],
  lesson: ["@teacher", "@student"],
  library: ["@teacher"],
  notes: ["@annotation"],
  "student-ai": ["@ai"],
  student: ["@student"],
  students: ["@teacher"],
  "teacher-attempts": ["@teacher"],
  "teacher-backup": ["@teacher"],
  "teacher-settings": ["@teacher"],
};

/** apps/server/src/routes/<去 .ts 文件名> → 标签；未列（public、auth 等）→ 全量。
 *  .test.ts 在收集阶段先归一化成同名 .ts，单测与实现文件同一映射。 */
export const ROUTE_TAGS = {
  admin: ["@admin"],
  content: ["@teacher"],
  "content-edit": ["@teacher"],
  import: ["@teacher", "@export"],
  library: ["@teacher"],
  shared: ["@export", "@teacher"],
  spec: ["@teacher"],
  courses: ["@teacher", "@student"],
  "public-ai-share": ["@ai"],
  student: ["@student"],
  "student-ai": ["@ai"],
  "student-annotations": ["@annotation"],
  "student-ink": ["@annotation"],
  "student-notes": ["@annotation"],
  "student-paper": ["@annotation"],
  "ink-profiles": ["@annotation"],
  "student-attempts": ["@student"],
  "student-corrections": ["@student"],
  "student-course-attempts": ["@student"],
  "student-courses": ["@student"],
  "student-events": ["@student"],
  "student-hints": ["@student"],
  "student-lectures": ["@student"],
  "student-lesson": ["@student"],
  "student-note-read": ["@student"],
  "student-practice-question-submit": ["@student"],
  "student-practice-workflow": ["@student"],
  "student-records": ["@student"],
  "student-review-pack": ["@student"],
  "student-wrong-practice": ["@student"],
  "student-wrong-questions": ["@student"],
  students: ["@teacher"],
  teacher: ["@teacher"],
  "teacher-ai": ["@teacher"],
  "teacher-analytics": ["@insights"],
  "teacher-api-token": ["@teacher"],
  "teacher-assignments": ["@teacher", "@student"],
  "teacher-attempts": ["@teacher"],
  "teacher-backup": ["@teacher"],
  "teacher-domain-isolation": ["@teacher"],
  "teacher-export": ["@export", "@insights"],
  "export-csv": ["@export", "@insights"],
  "teacher-media": ["@teacher"],
  "teacher-marks": ["@teacher"],
  "teacher-registration": ["@admin"],
  "teacher-review-pack": ["@student"],
  "teacher-reports": ["@insights"],
  "teacher-settings": ["@teacher"],
  "teacher-students": ["@teacher"],
};

/** e2e 档专属兜底：affected-lib 清单之外，对 e2e 而言全局性的变动 → 全量 */
const E2E_FORCE_FULL_PATTERNS = [
  // 所有包（不止 contract）：md-dsl/grading 等都会进两端
  /^packages\//,
  // 服务端数据层与装配入口
  /^apps\/server\/src\/db\//,
  /^apps\/server\/src\/app\.ts$/,
  // e2e 非 spec 基建：fake-ai-provider、annotation-assertions、navigation-ring、
  // review-resource-probe、fixtures 等（helpers/global-setup 已在 lib 清单）
  /^e2e\/fixtures\//,
  /^e2e\/(?!.*\.spec\.ts$)[^/]+\.ts$/,
];

/** 全量哨兵：映射表外的 apps/ 源码（跨功能面共享） */
const FULL = Symbol("full");

/** 单个变更路径 → 标签数组 | FULL | null（null = 非应用源码，不贡献标签） */
function tagsForPath(path) {
  // 单测视同同名实现文件（routes 下的 *.test.ts 测的就是同面路由逻辑）
  const normalized = path.endsWith(".test.ts")
    ? `${path.slice(0, -8)}.ts`
    : path;
  const feature = normalized.match(/^apps\/web\/src\/features\/([^/]+)/);
  if (feature) {
    return FEATURE_DIR_TAGS[feature[1]] ?? FULL;
  }
  const route = normalized.match(/^apps\/server\/src\/routes\/([^/]+)\.ts$/);
  if (route) {
    return ROUTE_TAGS[route[1]] ?? FULL;
  }
  // features/routes 之外的 apps 源码与配置（src/lib、pages、components、
  // services、vite.config.ts、package.json、public 资产……）都是跨功能面的
  if (/^apps\//.test(normalized)) {
    return FULL;
  }
  return null;
}

/**
 * 纯决策函数（供单测）：变更文件清单 → 选测决策。
 * 返回 { mode: "full", reason } 或 { mode: "grep", tags, reason }；
 * grep 模式 tags 恒含 @smoke 且居首。
 */
export function decideE2e(changed) {
  const libForce = hitForceFull(changed);
  if (libForce) {
    return { mode: "full", reason: `命中兜底文件 ${libForce}` };
  }
  for (const path of changed) {
    if (E2E_FORCE_FULL_PATTERNS.some((pattern) => pattern.test(path))) {
      return { mode: "full", reason: `e2e 兜底变动 ${path}` };
    }
  }
  const tags = new Set([SMOKE_TAG]);
  const hitFiles = [];
  for (const path of changed) {
    const specMatch = path.match(/^e2e\/([^/]+\.spec\.ts)$/);
    if (specMatch) {
      const specTags = SPEC_TAGS[specMatch[1]];
      if (!specTags) {
        return { mode: "full", reason: `未登记的 spec ${path}（先打标签）` };
      }
      for (const tag of specTags) {
        tags.add(tag);
      }
      hitFiles.push(path);
      continue;
    }
    const mapped = tagsForPath(path);
    if (mapped === FULL) {
      return { mode: "full", reason: `映射表外的应用源码 ${path}` };
    }
    if (mapped) {
      for (const tag of mapped) {
        tags.add(tag);
      }
      hitFiles.push(path);
    }
  }
  if (hitFiles.length === 0) {
    return {
      mode: "grep",
      tags: [SMOKE_TAG],
      reason: "无应用源码命中，仅冒烟",
    };
  }
  return {
    mode: "grep",
    tags: [SMOKE_TAG, ...[...tags].filter((tag) => tag !== SMOKE_TAG)],
    reason: `命中 ${hitFiles.join("、")}`,
  };
}

/** --only-changed 试探：返回「grep × only-changed」交集的用例数（0 = 不叠加）。
 *  --list 不启动 webServer；status!=0（无匹配用例等）一律按 0 处理。 */
function probeOnlyChangedCount(grep, ref) {
  const argv = [
    "pnpm",
    "exec",
    "playwright",
    "test",
    "--project=chromium",
    "--grep",
    grep,
    `--only-changed=${ref}`,
    "--list",
  ];
  const probe = spawnSync(toCommandLine(argv), {
    shell: true,
    encoding: "utf8",
  });
  if (probe.status !== 0) {
    return 0;
  }
  return probe.stdout.split("\n").filter((line) => /\.spec\.ts/.test(line))
    .length;
}

function main() {
  const ref = process.argv[2] ?? "v2";
  const decision = decideE2e(collectChangedFiles(ref));
  const summary =
    decision.mode === "full"
      ? `全量（${decision.reason}）`
      : `--grep "${decision.tags.join("|")}"（${decision.reason}）`;
  console.log(`[e2e-affected] 基线 ${ref}：${summary}`);

  const base = ["pnpm", "exec", "playwright", "test", "--project=chromium"];
  if (decision.mode === "full") {
    // 全量 = 全部用例，本档仍只跑 chromium；webkit 与双浏览器全量归 PR CI / 夜跑
    return runOrDryRun("e2e-affected", base);
  }
  const grep = decision.tags.join("|");
  const argv = [...base, "--grep", grep];

  // 叠加 --only-changed：纯应用源码变更时它会选空（import 图不认识应用源码），
  // 必须先试探交集，非空才叠加，映射表的结论不被清零
  if (process.env.AFFECTED_DRY_RUN !== "1") {
    const count = probeOnlyChangedCount(grep, ref);
    if (count > 0) {
      console.log(
        `[e2e-affected] 叠加 --only-changed=${ref}（交集 ${count} 条用例）`,
      );
      argv.push(`--only-changed=${ref}`);
    } else {
      console.log(
        `[e2e-affected] 不叠加 --only-changed（交集为空，应用源码不在 spec import 图内）`,
      );
    }
  }
  return runOrDryRun("e2e-affected", argv);
}

runIfMain(import.meta.url, main);
