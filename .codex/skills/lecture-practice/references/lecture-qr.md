# 出码：学生专属链接二维码（局域网扫码直达）

lecture-practice skill 第 3 步。老师在电脑上把服务跑起来后，脚本从本机 SQLite 只读读出学生
专属链接，终端出码并给出明文 URL；手机连同一个 Wi-Fi 扫码即打开学生端。

## 为什么只有这一件事要新做

- 服务端本就监听全部网卡（`@hono/node-server` 的 `serve()` 未指定 host），局域网通；
- 学生专属链接是既有机制：`students.link_token` → `GET /api/public/s/:token` 带 token 即登录，
  下发 90 天学生会话 Cookie；
- 仓库此前没有二维码实现，所以缺口只有「出码」这一步。

## 用法

```bash
# 项目根目录，服务已起着（生产态：网页与接口都在 8787）
node .claude/skills/lecture-practice/scripts/lecture-qr.mjs

# 指定学生（姓名 / id / 登录名片段都行；库里只有一名学生时可省略）
node .claude/skills/lecture-practice/scripts/lecture-qr.mjs --student 张三

# 开发态：pnpm dev 时网页在 Vite 5173
node .claude/skills/lecture-practice/scripts/lecture-qr.mjs --port 5173

# 顺带存一张二维码
node .claude/skills/lecture-practice/scripts/lecture-qr.mjs --out ./qr.svg   # 或 .png
```

参数：`--port`（缺省 8787）、`--db`（缺省 `./data/tutor.db`）、`--student`、`--host`、`--out`、`--json`、`--help`。

## 行为与红线

- 只读打开数据库（`node:sqlite` 的 `DatabaseSync({ readOnly: true })`），不写、不建表、不迁移；
- token 只出现在终端输出与 URL 里，不写任何日志文件；
- 归档学生不参与匹配（归档后专属链接登录本就失效）；
- 错误全中文：库不存在 / 没有学生 / 多匹配（列出候选）/ 该生无 token（提示去教师端重置）/
  专属链接登录已关闭 / 没有局域网地址。

## 排错顺序

1. 手机与电脑是否同一 Wi-Fi（2.4G/5G、访客网络、AP 隔离都会拦）；
2. 电脑防火墙是否放行端口（Windows 首次监听会弹窗，选「专用网络」）；
3. 多网卡机器用 `--host` 换一块网卡地址（有线 + 无线同时连时常见）；
4. 端口对不对：生产态 8787，`pnpm dev` 用 5173。

## 可选：低门槛反代（不当前置依赖）

局域网够用就不需要。要临时外网演示时：

```bash
cloudflared tunnel --url http://localhost:8787
```

一条命令拿到临时域名，把二维码内容换成该域名即可。注意这正是**把入口暴露到公网**：只用于临时
演示，用完即关；长期使用请按 `docs/部署.md` 走 Caddy/Nginx + 域名，并同步修改 `PUBLIC_URL`
（否则 CSV 导出里的手写笔迹绝对链接会因跨主机 Cookie 打不开）。本 skill 不引入 nginx。

## 依赖与安全

- 依赖仓库根 devDependencies 的 `qrcode`（纯 JS，无原生依赖）；生产容器若用 `--prod` 只装运行
  依赖，请在装过开发依赖的机器上出码，或用 `--json` 拿 URL 后自行画码。
- 二维码内容等价于登录凭据（90 天有效）：不要提交进仓库、不要发公开渠道；泄露后到教师端
  「重置专属链接」，旧码立即失效（已登录会话不受影响）。
