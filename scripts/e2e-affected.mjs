// e2e 按功能面标签选测（2026-10-25 第二版，替代首版「仅 spec 变动→跑 spec」的保守版）：
// 开发循环只跑受影响功能面 + 冒烟，且只跑 chromium；webkit 与双浏览器全量留给
// PR CI 闸门与每晚 schedule。决策链（自上而下，命中即止）：
//   1) 命中 affected-lib 兜底清单（依赖锁/各类配置/契约/迁移/scripts 等，见
//      affected-lib.mjs）或本脚本 e2e 兜底（packages/**、apps/server/src/db/**、
//      app.ts——前两条是对 lib 清单对应条目的本档加宽：lib 的 packages/contract、
//      db/schema+migrations 在本档放宽为整个 packages/ 与整个 db/）→ 全量
//      （全部用例，仍仅 chromium）；
//   2) e2e/ 目录 default-deny：除已登记标签的 *.spec.ts 外的一切路径
//      （helpers/global-setup 已由 lib 清单兜底；fixtures/、package.json、
//      未登记的新 spec、未来嵌套目录如 page-objects/）一律全量——比逐项
//      列举基建文件更稳，新增文件不可能静默漏成「仅冒烟」；
//   3) 应用源码经显式映射表命中功能面标签（apps/web/src/features/<面> 与
//      apps/server/src/routes/<文件>；.test.ts 视同同名实现文件）→
//      `--grep "@smoke|@x|@y"`。映射表不能省：应用源码不出现在任何 spec 的
//      import 图里，Playwright 自带的 --only-changed 认不到它们；
//   4) apps/ 下未进映射表的源码（features/markdown、features/shared、src/lib、
//      services、vite.config 等）是跨功能面共享 → 全量；
//   5) 仅 spec 变动（无任何应用源码命中）→ 直接以文件参数跑「变动 spec ∪
//      冒烟 spec」——比 grep 标签面更精确（改一个 spec 不必回归整个功能面），
//      也保留恒含冒烟。不用 Playwright 的 --only-changed 达成此事：它与
//      --grep 是 AND 关系，会把未变动的冒烟 spec 一并滤掉，违背「任何选测
//      结果恒含 @smoke」；
//   6) 其余变动（docs 等）不贡献标签；无任何命中 → 只跑 @smoke。
//
// 用法：node scripts/e2e-affected.mjs [ref]（默认 v2——本仓库开发循环的基线分支，
// 与 test:affected 的 origin/main 口径不同：v2 长期领先 main，以 main 为基线任何
// 分支都会摊成全量，选测就失效了）。
// 环境变量 AFFECTED_DRY_RUN=1 只打印决策不执行。
import {
  CMD_LENGTH_LIMIT,
  collectChangedFiles,
  existing,
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
  "teacher-ai-settings.spec.ts": ["@teacher", "@ai"],
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
  "qm-full-chain.spec.ts": ["@teacher", "@student"],
  "qm-device-perf.spec.ts": ["@teacher", "@student"],
};

/** 冒烟 spec（SPEC_TAGS 里登记 @smoke 的），「仅 spec 变动」档恒随跑 */
export const SMOKE_SPECS = Object.entries(SPEC_TAGS)
  .filter(([, tags]) => tags.includes(SMOKE_TAG))
  .map(([name]) => `e2e/${name}`);

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
 *  .test.ts 在判定前先归一化成同名 .ts，单测与实现文件同一映射。 */
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

/** e2e 档专属兜底：affected-lib 清单之外，对 e2e 而言全局性的变动 → 全量。
 *  packages/ 与 db/ 两条是 lib 清单对应条目（packages/contract、
 *  db/schema+migrations）在本档的加宽；e2e/ 目录的兜底不在此列——
 *  由 decideE2e 里的 default-deny 结构规则统一处理。 */
const E2E_FORCE_FULL_PATTERNS = [
  // 所有包（不止 contract）：md-dsl/grading 等都会进两端
  /^packages\//,
  // 服务端数据层与装配入口
  /^apps\/server\/src\/db\//,
  /^apps\/server\/src\/app\.ts$/,
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
 * - { mode: "full", reason }
 * - { mode: "specs", specs: [...], reason }  仅 spec 变动：specs = 变动 spec ∪ 冒烟 spec
 * - { mode: "grep", tags: [...], reason }    tags 恒含 @smoke 且居首
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
  const specHits = [];
  const tagSources = [];
  for (const path of changed) {
    if (path.startsWith("e2e/")) {
      const name = path.slice("e2e/".length);
      const specTags = SPEC_TAGS[name];
      // default-deny：已登记 spec 才放行；fixtures/、package.json、嵌套目录、
      // 未登记的新 spec 一律全量（新 spec 先去 SPEC_TAGS 打标签）
      if (!specTags) {
        return { mode: "full", reason: `e2e/ 下未登记路径 ${path}` };
      }
      specHits.push(name);
      continue;
    }
    const mapped = tagsForPath(path);
    if (mapped === FULL) {
      return { mode: "full", reason: `映射表外的应用源码 ${path}` };
    }
    if (mapped) {
      tagSources.push({ path, tags: mapped });
    }
  }
  if (specHits.length > 0 && tagSources.length === 0) {
    const specs = [
      ...new Set([...SMOKE_SPECS, ...specHits.map((n) => `e2e/${n}`)]),
    ];
    return {
      mode: "specs",
      specs,
      reason: `仅 spec 变动：${specHits.join("、")}`,
    };
  }
  if (specHits.length === 0 && tagSources.length === 0) {
    return {
      mode: "grep",
      tags: [SMOKE_TAG],
      reason: "无应用源码命中，仅冒烟",
    };
  }
  const tags = new Set([SMOKE_TAG]);
  for (const name of specHits) {
    for (const tag of SPEC_TAGS[name]) {
      tags.add(tag);
    }
  }
  for (const { tags: mapped } of tagSources) {
    for (const tag of mapped) {
      tags.add(tag);
    }
  }
  return {
    mode: "grep",
    tags: [...tags],
    reason: `命中 ${[...specHits.map((n) => `e2e/${n}`), ...tagSources.map((s) => s.path)].join("、")}`,
  };
}

function main() {
  const ref = process.argv[2] ?? "v2";
  const decision = decideE2e(collectChangedFiles(ref));
  // 已删除/改名的 spec 从直跑清单剔除（collectChangedFiles 有意保留已删文件，
  // 而 Playwright 的文件参数对不存在的路径只是匹配零用例并静默跳过——不过滤
  // 的话日志会谎称直跑了一个实际不存在的文件）
  const specs = decision.mode === "specs" ? existing(decision.specs) : [];
  if (decision.mode === "specs" && specs.length === 0) {
    console.log(
      `[e2e-affected] 基线 ${ref}：变动的 spec 均已删除（${decision.reason}），跳过；全量由 PR CI 兜底`,
    );
    return 0;
  }
  const summary =
    decision.mode === "full"
      ? `全量（${decision.reason}）`
      : decision.mode === "specs"
        ? `直跑 ${specs.join(" ")}（${decision.reason}）`
        : `--grep "${decision.tags.join("|")}"（${decision.reason}）`;
  console.log(`[e2e-affected] 基线 ${ref}：${summary}`);

  // 全量 = 全部用例，本档仍只跑 chromium；webkit 与双浏览器全量归 PR CI / 夜跑
  const base = ["pnpm", "exec", "playwright", "test", "--project=chromium"];
  if (decision.mode === "full") {
    return runOrDryRun("e2e-affected", base);
  }
  if (decision.mode === "specs") {
    const argv = [...base, ...specs];
    // 直跑清单超命令行上限时回退全量——分批跑会重复启动 webServer（每批 30s+）
    if (toCommandLine(argv).length > CMD_LENGTH_LIMIT) {
      console.log("[e2e-affected] 直跑清单超命令行上限，回退全量");
      return runOrDryRun("e2e-affected", base);
    }
    return runOrDryRun("e2e-affected", argv);
  }
  return runOrDryRun("e2e-affected", [
    ...base,
    "--grep",
    decision.tags.join("|"),
  ]);
}

runIfMain(import.meta.url, main);
