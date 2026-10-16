# B 系列外的稳定修复线

## 基线与隔离

用户已确认：从 B01 功能开发前的 `ebcaf4b9` 建立 `codex/stable-fixes`，课程与会话修复分别开分支，验收后仅合回此稳定线。暂不合并 v2/main，不引入 B 系列功能；B 系列完成后再整合。这一授权覆盖本次对默认合并顺序的调整。

工作目录使用 Codex 管理的独立 worktree。开发预览前端 5188、后端 8888，数据位于该 worktree 的 `data/stable-preview`，与主工作区及 B 系列数据库隔离。演示数据通过既有 `pnpm seed:demo` 创建。自动 E2E 仍使用独立临时库和 5199/8899。

## 实施计划

1. `codex/fix-course-sync`：先补课程变更后内容树未失效、导入页数据来源的失败测试；导入页复用课程列表查询，课程变更同步失效内容树，提供读取失败重试与提交保护。文件：course-queries.ts/test、ImportPage.tsx/test、e2e/course-cache.spec.ts、AGENTS.md。
2. `codex/fix-session-cache`：先复现活动 me 订阅在 removeQueries 后仍持有旧身份、链接换号复用业务缓存及旧请求迟到；保持 me 查询对象，取消旧查询并清理对应角色业务缓存，退出重置身份查询，登录发布新身份。教师端同口径清理管理缓存；不清理另一角色会话，不删除本机手写稿。文件：student-auth.ts/test、teacher-auth.ts/test、必要的共用查询清理 helper、e2e/password-login.spec.ts、AGENTS.md。
3. 两分支分别做简化及正确性审查，检查数据隔离；执行定向与全量单测、类型检查、lint、构建及 Chromium/WebKit 真实浏览器测试，再合回稳定线。

## 手动验收

- 先打开导入页，再通过导航新建课程，返回资源库导入；不刷新即可选择新课程。改名、归档和删除后课程选项同步。
- 学生甲登录并查看课程，退出后密码登录学生乙；姓名及课程切换正确。直接访问另一学生专属链接也不得保留旧缓存。
- 师生会话可以并存，退出其中一方不影响另一方。
- 切号不会删除本机未同步手写材料；旧查询迟到不得覆盖新身份。

## 课程修复记录

- RED：课程变更测试 4/4 失败，导入来源测试 1/1 失败，均命中预期缺口。
- GREEN：课程查询与导入页 37/37 通过；类型检查和构建通过。
- 浏览器：无刷新课程回归 Chromium/WebKit 2/2 通过。
- 简化审查：复用现有 useTeacherCourses 和 contentTreeKey，无新依赖、无重复类型。
- 正确性审查：只提供未归档课程；读取失败有重试；选中课程失效时不能继续预览；不涉及学生载荷、判分或服务端权限。
- lint：0 error，18 个既有 warning、1 个 info。全量集成验证结果见下文。

初始技能目录未列出工作流技能；收尾继续搜索后找到并读取 `.zcode/skills/code-review/SKILL.md`，按上下文、高层、逐行、结论四阶段审查，补查 React/TanStack Query 与并发参考。其余专项工作流文件未找到，以实际根因复现、TDD、简化及命令验证执行对应纪律。


## 账号修复记录

- RED：新增会话缓存回归 5 例，旧实现 4 例失败（密码/链接登录残留学生业务、教师退出和登录残留业务）；基本退出重登身份用例在旧实现可通过，因此不将“活动订阅必然残留旧姓名”当作已证实根因。
- GREEN：账号、登录页与布局守卫 7 文件 41/41 通过，包含旧身份请求迟到、两种登录入口清理业务缓存、师生互不清理及既有同账号手写会话保留。
- Chromium/WebKit：密码登录、甲退出乙登录后的姓名与课程、教师会话保留，以及课程无刷新回归合计 6/6 通过。
- 简化审查：clearAccountQueries 统一两角色取消/清理顺序，只保留必须持续订阅的 me 查询，无新依赖或新增契约类型。
- 正确性与隔离审查：取消旧 promise 后迟到结果不写回；teacher 同时清理 admin 前缀；student 不清理 teacher；登录新身份在清理后发布；退出保留原有草稿/标画解绑，未删除本机稿；没有服务端接口、答案权限或数据库变更。

## 本地运行

在本 worktree 根目录分别用两个 PowerShell 终端运行（已启动时无需重复启动）：

```powershell
$env:PORT='8888'
$env:DATA_DIR=(Join-Path (Get-Location) 'data/stable-preview')
$env:PUBLIC_URL='http://127.0.0.1:5188'
pnpm --filter server dev
```

```powershell
$env:DEV_API_PROXY_TARGET='http://127.0.0.1:8888'
pnpm --filter web exec vite --host 127.0.0.1 --port 5188 --strictPort
```

访问 `http://127.0.0.1:5188`。请持续使用同一主机名进行切号验收，localhost 与 127.0.0.1 的 Cookie 相互独立。演示学生陈小明、李小红、王小刚，密码均为 `demo-pass-123`；演示教师 demo 的初始密码由 seed:demo 首次运行生成，仅在本机会话交付，不写入仓库。


## 最终验证与审查结论（2026-10-16）

```text
pnpm test --maxWorkers=4 --reporter=verbose
Test Files  368 passed (368)
Tests       4350 passed (4350)
退出码      0

pnpm typecheck
contract / grading / md-dsl / server / web: Done，退出码 0

pnpm lint
0 error，18 warnings、1 info（既有基线），退出码 0

pnpm build
服务端打包及前端构建完成，退出码 0

pnpm e2e e2e/password-login.spec.ts e2e/course-cache.spec.ts --workers=2
6 passed (19.1s)，退出码 0
```

执行日志保存在本 worktree 忽略目录 `data/stable-preview/`：final-tests.log、session-typecheck.log、session-lint.log、session-build.log、session-e2e.log。全量默认并发首次运行未及时汇总，限并发重跑；最终在源代码不再变化后以四进程重新执行全量并确认通过，不将中断运行算通过。

code-review 四阶段及仓库七项专项检查完成：无阻塞发现；无新接口/载荷/契约/迁移/DSL/判分改动，无 any、ts-ignore、新依赖或 CDN。账号缓存安全检查覆盖查询取消与迟到结果、角色间隔离、管理数据清理及手写本机稿保留。手动舒适度与真实生产数据验证未执行，本次为独立演示库和自动浏览器验证。

本次只向 codex/stable-fixes 合并；不向 v2/main 推送或合并。B 系列完成后的整合仍需在届时版本重新验证。
