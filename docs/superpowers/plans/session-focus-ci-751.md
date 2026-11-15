# PR165 CI #751 退出回跳断言窄修计划与记录

起点b83065825befc4ce519ffd6eae8f3ddc438e0736/tree19b4dd65a709784d3f5ae396743089e64ebb59ee，原session-focus独立树。CI公开head84063cf8575f01f149c0e413e628146fef0434ff与本地起点tree相同；CI合并树e8b189bb71ce9521a01f887cd16f028ffd333a5e，实际target d02f90ab3bf9aec2af9fe011fe7e5d9376ee87a0。

先独立读取GitHub job132238962358完整日志后分类，主会话批准只修一处已有证据断言：

1. 硬失败：personal-account.spec.ts退出case两个browser各初轮/重试都等待裸/p/login，真实为同源/p/login?returnTo=%2Ft%2Fsettings%3Fsection%3Daccount。PortalGuard在UNAUTHORIZED时保留pathname+search+hash，personal账号复用个人loginPath；loginPathWithReturnTo添加returnTo。既有PortalGuard.test覆盖完整query/hash回跳；此行为来自已审门户继承，不能改生产迎合旧测试。
2. 两个global errors：日志00:20:49Z原文为“Timed out waiting 2700s for the test suite to run”和“Timed out waiting 2700s for the teardown for test suite to run”。372例/2workers，347pass、2fail、2flaky、1skip、20notrun，45分钟总时限中止于WebKit teacher-navigation-settings.ts82。四次旧URL失败各18.1/18.2/18.1/18.3s，错误轮询合计约60s；PR167另一轮完整选测376例（比本轮多4例）仍37分钟，不能称两轮集合完全相同，也不能据此解释约8分钟差距；具体用例差异与耗时因果未知。globalTimeout/worker/选择/重试配置均不改。
3. AI link conn期待201收到401，首次失败后重试通过：由主会话另派review_portal_navigation只读诊断，本执行不重复或抢改。
4. WebKit question-process.ts299期待全部已保存，实际有稿件同步需处理/本机稿已保留（20s），重试通过；日志不足以证明具体产品或夹具因果，未据此修改草稿同步/超时/断言，后续若复现再取trace定位。

实施：仅修改原退出case，从fixture baseURL构造完整预期URL，严格toHaveURL字符串+origin/pathname/hash+query entries恰为唯一returnTo。原teacher/me和student/me各401断言逐字保留。不引入helper/新spec，不改schema、产品、harness、配置或SPEC_TAGS。

TDD：先本地原case Chromium workers1/retries0真实红灯，确认与CI同一实际URL；保留原trace/screenshot/日志，再改严格断言并跑同case绿灯。WebKit仅用已有cache/LD可用性；缺库如实记录不临时安装。浏览器收口后e2e tsc/changed lint/diff/治理/规模，双会话401必须实际执行。两条全局超时、首轮flaky和完整full缺口保留，修断言不能宣称新CI已全绿/Ready。

最终证据、完整scope和冻结信息保存树外session-focus/ci-751/，不覆盖先前UI/harness审查。主会话安排原review_context_metadata补审；执行端不push/merge/派子，不自行转Ready。


结果：原case Chromium单worker零重试1例真实失败，实际完整URL与CI一致（case17.4s）。改严格断言后同case1例通过exit0（case2.8s/run6.1s），两条/me401实际执行。红trace/screenshot/error-context在green前已另存chromium-red-artifacts并核hash，未被后续output覆盖。WebKit缓存launch实测缺libGLESv2.so.2，exit1，未安装、未运行双project；不是WebKit产品用例失败，也不计测试通过。e2e tsc通过exit0；其余包类型/生成/单测/I16无源变更，复用既有证据。

浏览器退出后5199/8898/8899监听为0，本树live node/pnpm/chrome/WebKit/esbuild为0；窗口已交还。此修复仅保证退出断言符合真实已审契约，CI45分钟总时限差异/既有两flaky尚无本次修复证明，完整新CI需实际全绿后再由主会话判断Ready。
