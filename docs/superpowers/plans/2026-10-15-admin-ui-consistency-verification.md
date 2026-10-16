# 管理端界面统一验收记录（2026-10-15）

## 实施范围与隔离

- 分支：`codex/admin-ui-consistency`，从 `v2@99122069` 创建独立 worktree。
- B02 主工作区 `C:/Users/HUAYU/Documents/github/simple-tutor-tool` 的分支、已跟踪文件、数据库及开发服务未修改。本聊天首轮计划的同名临时副本已核对并备份移出主工作区，避免后续合并被未跟踪文件阻挡。
- 移除教师设置中的个人手写手感链接；学生设置和既有手写路由保留。
- 管理端三个页面复用教师主题、Brand、Sheet、Button、页面容器和标题样式，导航和权限守卫独立。
- 不修改学生端源码、共享 CSS、API、契约或数据库，不增加依赖。

## TDD

先执行：

```text
pnpm test apps/web/src/pages/admin/AdminLayout.test.tsx apps/web/src/pages/teacher/SettingsPage.test.tsx
Test Files  2 failed (2)
Tests       4 failed | 9 passed (13)
```

失败覆盖：教师入口仍存在、品牌/主题缺失、管理子页与概览同时高亮、抽屉缺失。实现后执行相关回归：

```text
pnpm test apps/web/src/pages/admin apps/web/src/pages/teacher/SettingsPage.test.tsx apps/web/src/pages/teacher/TeacherLayout.test.tsx
Test Files  6 passed (6)
Tests       38 passed (38)
```

纯样式的容器、标题、输入宽度调整按项目约定豁免逐项失败测试，以真实浏览器验收覆盖。

## 质量闸门

未找到 `/simplify` 技能文件，先在完整 diff 上完成等效简化检查；随后使用仓库 `.zcode/skills/code-review/SKILL.md` 及其 React 指南完成上下文、高层、逐行、结论四阶段审查。

- 简化检查：复用现有品牌、主题 token、页面容器和抽屉组件。仅给 Brand 增加可选紧凑副标题，默认值保持教师端行为；管理导航共用一份条目数据。不提取跨两端的通用布局框架，避免扩大修改范围。
- code-review（通过）：核对管理员/未登录/非管理员/请求失败分支、主题挂载清理与 Portal 继承、导航高亮边界、窄屏抽屉关闭与焦点返回、教师设置分类控制器保活。无未处理的确认发现。
- 本次不触及学生载荷与答案数据，无需新增学生接口泄露测试；全量测试继续覆盖现有防泄露断言。
- UI polish：未发现可操作的新增问题。桌面概览/教师管理/共享文件、390px 共享文件和手机管理弹窗已检查截图；各交互由 Chromium/WebKit 真实回归验证。Approve（限本次 diff 与所列页面）。

## 验证

```text
pnpm typecheck
packages/contract typecheck: Done
packages/grading typecheck: Done
packages/md-dsl typecheck: Done
apps/server typecheck: Done
apps/web typecheck: Done
# 包含 e2e/tsconfig.json 检查，退出码 0。

pnpm lint
Checked 979 files in 1092ms. No fixes applied.
Found 18 warnings.
Found 1 info.
# 退出码 0；既有警告未扩大范围处理。

pnpm build
✓ built in 2.98s
PWA v1.3.0
precache 375 entries (12166.02 KiB)
# 退出码 0；存在既有大 chunk 提示。

pnpm e2e e2e/admin-ui.spec.ts e2e/student-settings.spec.ts e2e/teacher-register-admin.spec.ts --workers=2
14 passed (51.9s)
```

浏览器验证使用项目隔离的临时数据库与 8899/5199 端口，没有复用用户开发服务或向线上写入。覆盖 Chromium/WebKit、1280px 桌面、390/820/1023px 窄屏、三页导航与高亮、Esc/焦点返回、教师与管理端往返主题、管理弹窗主题、长登录名、学生手感保存、学生未登录守卫、教师注册与管理注册开关。

全量单测（退出码 0，包含现存 samples 的解析/渲染回归）：

```text
pnpm test --maxWorkers=2
Test Files  369 passed (369)
Tests       4375 passed (4375)
Duration    518.15s
```

## 手动验证

1. 教师登录后进入 `/t/settings?section=teaching`，确认只展示学生作答配置，无「调整我的手写手感」。
2. 学生从头像进入设置，再进入手写手感，保存配置并返回，确认当前配置名称更新。
3. 管理员从教师设置「账号与会话 → 系统管理」进入，检查三个页面的 OwnClass 品牌、靛蓝选中态、标题和留白。
4. 把窗口缩至 1024px 以下，打开菜单进入三个页面，检查抽屉关闭、Esc 返回焦点与无横向溢出。
5. 在教师管理打开创建弹窗，检查配色；取消后返回教师端，确认主题正确。
6. 普通教师直接访问 `/a` 应返回教师端；未登录访问应进入登录页。

## 合并记录

全部自动检查已通过；按项目流程先合并 `v2`，再合并本地 `main`，最终提交与合并结果以 Git 日志及任务交接为准。本次不操作远端部署。
