# 教师设置入口与管理端界面统一实施计划

## 目标与范围

1. 教师设置不再展示「调整我的手写手感」；学生继续通过账号设置自行调整。既有手写路由暂保留兼容，避免把入口移除扩大为底层能力删除。
2. 管理端沿用教师端 OwnClass 品牌、靛蓝主题、侧栏、顶栏、页面标题、留白与卡片样式；管理导航和权限守卫保持独立。
3. 不修改 API、契约、数据库、判分或学生数据投影，不新增依赖。

## 文件清单

- `apps/web/src/pages/teacher/SettingsPage.tsx`：删除教师手感入口。
- `apps/web/src/pages/teacher/SettingsPage.test.tsx`：增加入口不再展示的回归断言。
- `apps/web/src/pages/admin/AdminLayout.tsx`：统一品牌、主题、桌面侧栏、账号区域、面包屑、跳至内容及窄屏抽屉。
- `apps/web/src/pages/admin/AdminLayout.test.tsx`：导航、主题生命周期、当前项高亮、抽屉交互与权限回归。
- `apps/web/src/pages/admin/AdminOverviewPage.tsx`、`AdminTeachersPage.tsx`、`AdminSharedFilesPage.tsx`：统一页面容器、标题和展示层样式，覆盖加载、错误与空态。
- `apps/web/src/components/`、`apps/web/src/index.css`：按需复用或提取教师与管理端共有的最小展示组件/主题入口，不引入通用布局框架。
- `apps/web/src/pages/teacher/TeacherLayout.tsx` 及其测试：仅在提取共用展示逻辑时调整并回归。
- `e2e/admin-ui.spec.ts`：新增管理端桌面与窄屏真实浏览器回归。
- `AGENTS.md`：同步教师入口移除及管理端共用视觉约定，保留既有路由的兼容说明。

## 实施顺序

1. 用户确认计划后，新建 `codex/admin-ui-consistency` 分支。
2. 先补教师入口、管理布局与导航行为的失败测试，再实现。纯样式调整豁免逐项失败测试，以浏览器验证覆盖。
3. 复用现有 Brand、Sheet、Button 和教师主题；抽屉选择导航后关闭，管理端 Portal 弹层继承同一主题。
4. 统一三张管理页的容器、标题、卡片与表格/操作区，确保长账号、空态与窄屏布局可用。
5. 对完整 diff 依次执行 simplify 与 code-review 审查，修复确认的问题。相关技能若不可用，明确记录并执行等效检查，不声称已调用。
6. 执行单测、类型检查、lint、构建及相关真实 Playwright（Chromium/WebKit，项目隔离端口与数据库），记录命令与结果；检查现存样例兼容性回归。
7. 小步提交；全绿后依项目流程合并 v2，再发 main。若存在发布或远端权限阻碍，明确报告实际完成边界。

## 测试与手动验收

- `/t/settings?section=teaching` 不再出现教师手感链接；分类切换、未保存保护与作答方式保存继续正常。
- `/s/settings/ink-feel` 仍可正常进入、调整和保存配置。
- `/a`、`/a/teachers`、`/a/shared-files` 的品牌、背景、靛蓝选中态、标题和间距与教师端一致。
- 管理员只看到管理导航；未登录仍跳登录页，普通教师仍无法进入管理端。
- 桌面固定侧栏；1024px 以下通过抽屉进入完整导航，键盘操作与焦点返回正常，页面无意外横向溢出。
- 从教师端进入管理端、管理端返回教师端及离开两端后，主题挂载/清理和弹窗配色正确。
- 注册开关、教师管理与共享文件操作保持原有行为，不用线上真实写操作进行视觉验收。

## 当前状态

用户已确认，在 `codex/admin-ui-consistency` 独立 worktree 实施，基线为 `v2@99122069`。主工作区的 `codex/student-ai-b02` 未切换，已跟踪文件未修改。实现与验证已完成：4375 项单测、14 项真实浏览器回归、类型检查、lint 与构建通过；详见同目录验收记录。
