# M04 P1 单选作业隔离联调

本地取证使用真实 OwnClass 教师 setup、导入、布置和两个学生登录。在原作业开卷 URL 使用与默认产品共用的请求解析和学生守卫。隔离装配早于默认路由匹配，把开卷交给固定候选包。其它产品路由由 `createApp` 提供。默认装配仍调用原作业开卷服务。

候选从产品开卷使用的题集与上下文闭包取两道合成题。题面经 `studentStemMd` 投影，评分键作为服务端发布输入，作业没有独立材料、题组或阅读步骤。夹具来自 learning-kernel 修订 `97fb964e3b6bc9192c9e761bc13d3c9d9e2759e0` 的 `docs/迁移/M04`；冻结 JSON 与原文件数据一致，采用产品的 JSON 排版。临时目录内有相互独立的产品和内核 SQLite。

## 本地复跑

产品使用锁定依赖，需有 Node 24.19.x、pnpm 12.6.0，以及已固定的 `learning-kernel-0.1.0.tgz` 与 `zod-4.6.5.tgz`。在产品根目录执行下列命令，将包路径、受信 SHA-256 和期望模式替换为本次候选。每个候选使用独立安装目录。

```powershell
pnpm install --frozen-lockfile --offline
pnpm exec vitest run apps/server/src/routes/m04-p1-assembly.test.ts

$m04KernelTar = 'C:/local-candidates/learning-kernel-0.1.0.tgz'
$m04ZodTar = 'C:/local-candidates/zod-4.6.5.tgz'
$m04Sha = 'c8a47328ae6f38e01e1f4b109fc4fab95971b0c0a382fd0b411ec8003caec0bb'
$m04Mode = 'open'
$m04Install = Join-Path $PWD.Path ("node_modules/.ownclass-m04-" + $m04Sha.Substring(0, 8))
New-Item -ItemType Directory -Path $m04Install | Out-Null
Copy-Item -LiteralPath $m04KernelTar -Destination (Join-Path $m04Install 'learning-kernel-0.1.0.tgz')
Copy-Item -LiteralPath $m04ZodTar -Destination (Join-Path $m04Install 'zod-4.6.5.tgz')
Push-Location -LiteralPath $m04Install
try {
  '{"private":true}' | Set-Content -Encoding utf8NoBOM package.json
  npm install --offline --ignore-scripts --no-audit --no-fund ./learning-kernel-0.1.0.tgz ./zod-4.6.5.tgz
  if ($LASTEXITCODE -ne 0) { throw '离线安装未通过' }
} finally {
  Pop-Location
}
pnpm --dir apps/server exec tsx src/test/m04-p1/probe.ts $m04Install $m04Mode $m04Sha
if ($LASTEXITCODE -ne 0) { throw 'P1 探针未通过' }
```

K1 原包 SHA-256 为 `4f24ba26cda0f0b2688cbd8057189186f55bc88e783470346acc4f20df4937b8`，使用 `reject-material` 模式。此模式预期同一个正常开卷请求返回 `500 M04_PUBLISH_REJECTED`，候选内部拒绝 `material` 与 `practice.material`。产品没有作答、成绩、证据和结算，内核没有练法或活动。

`open` 模式要求重复开卷获得同一个真实内核回执、本人在既有详情 URL 读到相同冻结题、另一个学生被拒绝。关闭重开内核 SQLite 后复验本人读取，并用真实教师请求更换作业名单验证当前授权。产物输出各库路径和实际行数。Vitest 的独占路由用例使用候选替身，无需安装内核候选。

活动与作业的关联只保存在本次隔离进程。隔离详情输出内核公开只读结果，题目冻结身份、草稿版本与整卷确认仍需实证。P1 两个固定包只有 `publish`、`start`、`read`、`close`。可运行的保存、完整／全空／部分交卷和原样重发需等公开接口；探针记录包实际暴露的方法，供后续对照。
