# M02-import-preview 教师导入预览兼容实证

固定旧产品 `49a3fb0721c16cf9a2ba4f3d1f4fe89c471e3908` 与迁移产品 `1394dcfffb0c91910d4a532dabcfcfb8e269b635` 的 [逐文件报告](preview-evidence.tsv) 字节一致。探针在两个独立检出中运行同一份脚本，监听回环地址，通过教师首设、密码登录和真实 Cookie 访问 `/api/teacher/me`、`POST /api/teacher/import/preview` 和 `POST /api/teacher/import/preview-batch`。

## 两版共同结果

- 冻结清单中的 39 份发布样例均可直接提交预览。开启新内容时单份全部 HTTP 200，按诊断分为 12 份无诊断、6 份仅警告、21 份含错误。批量响应保留文件顺序和单份预览语义，因同单元或同目标文件夹讲义标题冲突而额外阻止的文件可在 `batch-conflicts` 列定位。
- 关闭新内容时 24 份样例的预览正文与开启时一致，15 份 HTTP 403 `NEW_CONTENT_DISABLED`，`off-usages` 记录各命中项和行列。混入一份命中新内容闸门的有效样例，整批 HTTP 403。
- `练习推荐样例.md` 的空判断答案在两版均产生 `JUDGE_INVALID_ANSWER@10:1`。给另一位教师实际导入同编号材料后，跨域引用样例仍显示 `UNKNOWN_MATERIAL_REF@11:1`。材料所有者提交同一份样例可解析该引用。预览行为与文件名所写的 `MATERIAL_REF_OUT_OF_DOMAIN` 有历史差异。
- 真实注册表有 26 个主名、零别名。固定样例正文出现 21 个主名，缺 `box`、`col`、`columns`、`graph` 和 `rubric`。四份 `synthetic/` 输入独立于固定分母。合法教学包使用注册表分栏例，覆盖 `columns`、`col` 和栏内 `graph`。讲义 `box` 和 `solve` 题 `rubric` 各有一份有效输入，两者开关两态均 HTTP 200、无诊断、可在批量中确认。解析侧分别核对盒正文保留及四个量表项。HTTP 可观察到讲义或练习摘要、导入动作和诊断，版式渲染及量表评定属于后续流程。
- 合成包中已注册指令和校验器依赖通过，正文未知指令仍报 `UNKNOWN_DIRECTIVE@17:1`。声明不存在的依赖时另报 `DIRECTIVE_REF_NOT_FOUND@2:1` 和 `VALIDATOR_REF_NOT_FOUND@2:1`，批量将该文件标记为 `hasError`。匿名预览 HTTP 401。
- 预览前后资源、材料、题组、目录、批次留档等 11 张表的完整行及数据目录文件名一致。数据库有 89 次变更，与鉴权守卫逐请求续期的次数一致。唯一既存文件是应用初始化生成的 `secret.key`，报告只记录文件名。材料预置在取快照前完成。

报告中 `issues` 保留诊断级别、错误码、行和列，`warnings` 保留导入警告码。各 HTTP 返回的 SHA-256 覆盖完整 JSON，对象键排序，数组保序。`source-sha256` 对发送的 Markdown 字符串做相同的 JSON 摘要，换行统一为 LF。报告只保存摘要和公开夹具的结构值。HTTP 摘要没有题序字段，`question-order`、`group-order`、`lesson-order` 来自预览使用的解析链和讲练切段，探针将解析摘要与 HTTP 摘要交叉验证。

## 复跑

在 PowerShell 中将 `$m02OldCheckout`、`$m02NewCheckout` 和 `$m02KernelRepo` 设为相应仓库的绝对路径。两个产品检出应已安装各自锁定的依赖。本次使用 Node 24.19.0、pnpm 12.6.0。脚本从待测检出的当前目录加载服务和样例，报告写到临时目录。

```powershell
$m02Evidence = Join-Path $m02NewCheckout 'apps/server/src/test/m02-import-preview'
$m02Probe = Join-Path $m02Evidence 'probe.mjs'
$m02Manifest = Join-Path $m02KernelRepo 'docs/迁移/M00/契约与内容.tsv'
$m02OldReport = [IO.Path]::GetTempFileName()
$m02NewReport = [IO.Path]::GetTempFileName()

Set-Location $m02OldCheckout
if ((git rev-parse HEAD) -ne '49a3fb0721c16cf9a2ba4f3d1f4fe89c471e3908') { throw '旧侧检出修订有误' }
node --import ./apps/server/node_modules/tsx/dist/loader.mjs $m02Probe $m02Manifest $m02OldReport
if ($LASTEXITCODE -ne 0) { throw '旧侧预览探针失败' }

Set-Location $m02NewCheckout
node --import ./apps/server/node_modules/tsx/dist/loader.mjs $m02Probe $m02Manifest $m02NewReport
if ($LASTEXITCODE -ne 0) { throw '迁移侧预览探针失败' }

git diff --no-index -- $m02OldReport $m02NewReport
if ($LASTEXITCODE -ne 0) { throw '预览行为不同' }
git diff --no-index -- $m02NewReport (Join-Path $m02Evidence 'preview-evidence.tsv')
if ($LASTEXITCODE -ne 0) { throw '结果与已记录证据不同' }
```

产品侧既有 HTTP 路由选测 `pnpm exec vitest run apps/server/src/routes/import.test.ts -t 'POST /api/teacher/import/preview' --maxWorkers=1` 通过 9 例，其余 39 例由名称过滤。
