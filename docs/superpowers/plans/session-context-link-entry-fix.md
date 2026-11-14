# PR160 专属链接入口重放修复

依据根确认的P2与只读诊断6c95dd57，保留服务端同设备旧会话撤销、owner/type隔离和160的StudentScreen。只修同一页面入口自动兑换及其异步身份应用；后续真实合入161时保留LoginShell。

内部行为协议（现有HTTP/Zod载荷不变）：

1. 每次effect setup拥有独立attempt代际、AbortController和结果。兑换排入该setup的microtask；已cleanup的setup不发请求。StrictMode第二setup仍能完成，不缓存已完成token或Cookie，不sleep、不自动重试。
2. token改变、真卸载立即abort旧兑换并使代际失效；旧完成不得应用身份或跳转。人工重试创建新attempt；新挂载同链接必须重新兑换有效会话。
3. 身份应用与角色缓存清理均在异步边界后复核入口门；旧A等待cancelQueries期间若B已生效，不得remove B缓存、绑定A草稿/偏好或启动A预取。旧调用缺省门保持原语义。
4. AbortSignal精确传给专属链接endpoint；提取该endpoint到独立API模块、保留api.ts兼容导出并下降历史规模基线，避免TanStack第二context误作signal。新增生产文件小于400行。
5. 先真页StrictMode+真实RPC/fetch边界红测试，再实现。验证失败人工retry、A到B、卸载及退出重进、缓存/草稿/预取隔离；原52断言Hono探针保持为撤旧规则对照，不能冒充browser。
6. 申请共享browser窗口后以真实Chromium、1worker/0retry验证同设备立即AI仍201以及可控晚A响应对原生Cookie和/me主体的影响；保留原student-ai三失败case断言。若不能控制或证明nativeCookie边界，如实记录而非用React gate冒称解决。WebKit缺系统库时报告未跑，不安装系统依赖。
7. 单worker定点、web/e2e类型、轻gates；无公共契约改动不重生成。冻结全58路径加增量的四份范围/新增清单/HEAD/tree/实数与首失败；提交footer Krow-Task: session-context，独立审核交根。不改其他树/无关API/迁移/退出断言，不发布或派子。
