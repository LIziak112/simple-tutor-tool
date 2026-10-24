# iPad 圈画本机保存失败修复

用户已确认实施计划。分支：`codex/ipad-annotation-persistence`。

## 问题与证据

- 截图显示本机保存失败、圈画警告及顶部红色 `null`，刷新后再次出现。
- `idb-keyval` 在事务中止时以 `transaction.error` 拒绝 Promise，此值可以为空；原标画仓将其 `String(null)` 后展示。
- 原收笔和缓存底图打开只等待队列、检查失败状态，没有重新写入失败记录的路径。
- 原错误条在工作区外读取仅在工作区内定义的标题高度变量，回落 64px，并以高于标题的悬浮层展示。
- 这些路径已通过故障注入复现；没有原设备现场日志，不能确认那次存储中止的具体原因。

## 文件与实现步骤

1. `lib/kv-backend.ts`、`lib/local-persistence-error.ts` 及测试：提供空错误、空间不足、权限和连接异常文案；瞬态连接失败后关闭旧连接，为下一次显式操作重建连接，不自动重放写入。
2. `annotation-store.ts`、`QuestionAnnotationOverlay.tsx`、`question-annotation-base.ts` 及测试：复用原队列重写失败记录，保留底图、正文、文档版本和待传标识；未成功前保留失败保护。
3. `AttemptEditorContext.tsx`、`AttemptHeader.tsx`、`StudentLessonPage.tsx` 及测试：错误进入正常布局，提供可防重复点击的重试；失败保留编辑者，成功继续原操作，用户选择留在当前题时取消旧目标。
4. `e2e/annotation-local-base.spec.ts`、`e2e/annotation-paper-interaction.spec.ts`：真实浏览器中止 IndexedDB 事务，验证原稿保护、重试、刷新恢复和错误条几何位置。
5. 同步 `AGENTS.md`；完整 diff 简化和正确性审查；运行 lint、类型检查、全量单测、构建及相关 Chromium/WebKit E2E。

## 质量审查

- 简化：复用现有 `retryAnnotationPersistence` 和串行持久化队列，不新增原稿仓、存储结构或第三方依赖；提示单独订阅，保持按题订阅边界。
- 正确性：检查错误分类、旧连接迟到失败、重试并发、取消代次、失败不清稿、布局和账号隔离。修复审查发现的旧重试目标残留，回归测试覆盖。
- 不改变 API、答案投影、判分或契约，无新增学生端载荷；不需要迁移或生成规范。
- UI 故障截图已人工查看，提示位于标题下面，不覆盖标题，原圈画仍在。

## 自动验证结果

- `pnpm test --maxWorkers=8`：`Test Files 485 passed (485)`、`Tests 5760 passed (5760)`，251.30 秒。
- 相关七个测试文件单独回归：`Test Files 7 passed (7)`、`Tests 61 passed (61)`。
- `pnpm e2e e2e/annotation-local-base.spec.ts --workers=2`：`4 passed (13.7s)`。
- `pnpm e2e e2e/annotation-paper-interaction.spec.ts e2e/question-inline-annotation.spec.ts --workers=2`：`22 passed (2.4m)`。
- `pnpm lint`：`Checked 1230 files`，退出码 0。
- `pnpm typecheck`：e2e、contract、grading、md-dsl、server、web 全部退出码 0。
- `pnpm build`：各包及 PWA 构建完成，退出码 0。
- `git diff --check`：退出码 0。

自动检查通过；修复留在独立分支供候选部署和真机验收，验收后依次合并 v2、main。

## 手动验证（PR 描述可复用）

1. 部署候选版本后，用原 iPad 和账号打开出问题的作答，查看保存详情；若仍失败，记录完整新错误文案与 iPadOS 版本，不清理网站数据。
2. 在同题写两笔，点击作答或切题；如出现失败，确认原笔迹与编辑入口保留，点「重试操作」，只有保存成功后才能继续原操作。
3. 刷新重新进入，核对两笔、底图及作答仍在；再测试切后台/锁屏返回后继续圈画并保存。
4. 横竖屏各检查标题、错误提示、题面及工具栏无重叠。

真机 Pencil 验收仍待执行；桌面 WebKit 结果不替代真机验收。没有部署或修改线上原稿。
