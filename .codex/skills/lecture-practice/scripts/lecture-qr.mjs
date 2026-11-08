#!/usr/bin/env node
/**
 * 学生专属链接二维码 —— lecture-practice skill 第 3 步「出码」。
 *
 * 场景：老师在电脑上把服务跑起来后，脚本从本机 SQLite 读出学生专属链接，
 * 拼成 http://<局域网IP>:<port>/s/<linkToken>，终端出码 + 给明文 URL，
 * 同 Wi-Fi 的手机扫码直达学生端。
 *
 * 为什么能这么短：整条链仓库里都有，脚本只做三件本地事——
 * 1. 读库：students 表的 link_token（apps/server/src/db/schema.ts），只读打开，不做任何写；
 * 2. 选地址：@hono/node-server 的 serve() 未指定 host，服务端本就监听全部网卡，
 *    所以只要挑一个手机够得着的 IPv4，不用改服务端；
 * 3. 出码：学生链接走既有公开路由 GET /api/public/s/:token（带 token 即登录，
 *    90 天会话 Cookie），二维码编码它即可，不新造免登录机制。
 *
 * 红线：
 * - 对数据库只读（DatabaseSync readOnly），不写、不建表、不迁移；
 * - token 只出现在终端输出与 URL 里，不写任何日志文件；
 * - 生成的二维码等同于登录凭据：不要提交进仓库、不要发公开渠道；
 *   泄露后到教师端「重置专属链接」即可让旧码立即失效。
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { extname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import QRCode from "qrcode";

/** 服务端默认端口（生产态由服务端同时托管网页与接口） */
export const DEFAULT_PORT = 8787;
/** 默认数据库位置（仓库根启动时的 DATA_DIR 缺省值） */
export const DEFAULT_DB = "./data/tutor.db";

/** 虚拟/隧道网卡前缀：这些地址手机通常够不着，直接排除，避免挑错 */
const VIRTUAL_IFACE =
  /^(lo\b|docker|br-|veth|virbr|vmnet|utun|tun|tap|zt|tailscale|wg|ip6tnl)/i;

/**
 * 选出手机可能够得着的局域网 IPv4，按「像家庭/校园网」的程度排序：
 * 192.168.x.x > 10.x.x.x > 172.16-31.x.x > 其他。
 * 排除：回环、链路本地（169.254）、internal 标记、虚拟网卡。
 * @param {NodeJS.Dict<import("node:os").NetworkInterfaceInfo[]>} interfaces
 * @returns {{iface: string, address: string}[]}
 */
export function pickLanAddresses(interfaces) {
  const found = [];
  for (const [iface, entries] of Object.entries(interfaces ?? {})) {
    if (!entries || VIRTUAL_IFACE.test(iface)) continue;
    for (const entry of entries) {
      const family =
        typeof entry.family === "string" ? entry.family : `IPv${entry.family}`;
      if (family !== "IPv4" || entry.internal) continue;
      const address = entry.address;
      if (address.startsWith("127.") || address.startsWith("169.254.")) {
        continue;
      }
      found.push({ iface, address });
    }
  }
  const rank = (address) => {
    if (address.startsWith("192.168.")) return 0;
    if (address.startsWith("10.")) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
    return 3;
  };
  return found.sort(
    (a, b) =>
      rank(a.address) - rank(b.address) || a.address.localeCompare(b.address),
  );
}

/**
 * 拼学生专属链接。token 是 base64url，按路径段编码，防止误传整条 URL 时拼出坏地址。
 * @param {{host: string, port?: number, token: string, protocol?: string}} input
 */
export function buildStudentUrl({
  host,
  port = DEFAULT_PORT,
  token,
  protocol = "http",
}) {
  if (!host) throw new Error("缺少 host（局域网 IP）");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`端口不合法：${String(port)}（需要 1-65535 的整数）`);
  }
  const cleaned = String(token ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (!cleaned) throw new Error("缺少学生专属链接 token");
  if (/^https?:\/\//i.test(cleaned)) {
    throw new Error("token 需要的是 /s/ 后面那一段，不是整条链接");
  }
  const path = cleaned.split("/").map(encodeURIComponent).join("/");
  return `${protocol}://${host}:${port}/s/${path}`;
}

/**
 * 在库里挑学生（纯函数）：归档的学生不参与（归档后专属链接登录即失效）。
 * - 未给关键字：库里只有一名在册学生就直取，多于一名要求指定；
 * - 给了关键字：按姓名 / id / 登录名做大小写不敏感的子串匹配。
 * @param {{id: string, displayName: string, loginName: string, linkToken: string, linkEnabled: boolean, archivedAt: string | null}[]} rows
 * @param {string | undefined} query
 */
export function matchStudents(rows, query) {
  const alive = (rows ?? []).filter((row) => !row.archivedAt);
  if (alive.length === 0) return { status: "empty", matches: [] };
  const keyword = String(query ?? "")
    .trim()
    .toLowerCase();
  const pick = (matches) =>
    matches.length === 1
      ? { status: "single", student: matches[0], matches }
      : { status: "ambiguous", matches };
  if (!keyword) return pick(alive);
  const matches = alive.filter((row) =>
    [row.displayName, row.id, row.loginName].some((field) =>
      String(field ?? "")
        .toLowerCase()
        .includes(keyword),
    ),
  );
  if (matches.length === 0) return { status: "none", matches: [] };
  return pick(matches);
}

/** 学生能否用专属链接登录；能则返回 null，不能返回中文原因 */
export function studentLinkProblem(student) {
  if (!String(student?.linkToken ?? "").trim()) {
    return "该学生的专属链接令牌为空，去教师端「学生」页点「重置专属链接」后再试。";
  }
  if (student.linkEnabled === false) {
    return "该学生的专属链接登录已关闭，去教师端打开专属链接或重置后再试。";
  }
  return null;
}

/**
 * 解析命令行参数（纯函数，便于单测）。未知参数、缺值、越界端口一律抛错。
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const opts = {
    port: DEFAULT_PORT,
    db: DEFAULT_DB,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} 缺少取值`);
      }
      i += 1;
      return value;
    };
    switch (arg) {
      case "--port": {
        const raw = takeValue();
        const port = Number(raw);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(`--port 需要 1-65535 的整数：${raw}`);
        }
        opts.port = port;
        break;
      }
      case "--db":
        opts.db = takeValue();
        break;
      case "--student":
        opts.student = takeValue();
        break;
      case "--host":
        opts.host = takeValue();
        break;
      case "--out":
        opts.out = takeValue();
        break;
      case "--json":
        opts.json = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  return opts;
}

/**
 * 只读打开 SQLite，取学生表（列名以 apps/server/src/db/schema.ts 为准）。
 * @param {string} dbPath
 */
export function readStudents(dbPath) {
  if (!existsSync(dbPath)) {
    throw new Error(
      `找不到数据库：${dbPath}\n先在项目里启动一次服务（会创建 DATA_DIR/tutor.db），或用 --db 指定路径。`,
    );
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    throw new Error(`打不开数据库：${dbPath}\n${err.message}`);
  }
  try {
    const rows = db
      .prepare(
        `SELECT id, display_name AS displayName, login_name AS loginName,
                link_token AS linkToken, link_enabled AS linkEnabled,
                archived_at AS archivedAt
           FROM students`,
      )
      .all();
    return rows.map((row) => ({
      id: String(row.id),
      displayName: String(row.displayName ?? ""),
      loginName: String(row.loginName ?? ""),
      linkToken: row.linkToken == null ? "" : String(row.linkToken),
      linkEnabled: Boolean(row.linkEnabled),
      archivedAt: row.archivedAt == null ? null : String(row.archivedAt),
    }));
  } catch (err) {
    throw new Error(
      `读取 students 表失败：${dbPath}\n${err.message}\n确认这是本项目的数据库（应含 students 表）。`,
    );
  } finally {
    db.close();
  }
}

function printHelp() {
  console.log(`学生专属链接二维码

用法：
  node .claude/skills/lecture-practice/scripts/lecture-qr.mjs [选项]

选项：
  --port <端口>     学生端网页所在端口，默认 ${DEFAULT_PORT}（生产态服务端同托管网页）；
                    开发态 pnpm dev 的网页在 Vite 5173，此时传 --port 5173
  --db <路径>       数据库文件，默认 ${DEFAULT_DB}（相对当前目录）
  --student <关键字> 学生姓名 / id / 登录名的片段；库里只有一名学生时可省略，
                    多匹配时会列出候选让你再指定
  --host <IP>       用哪个局域网地址，默认自动选最像内网的那个
  --out <路径>      二维码落盘路径（.svg 默认，.png 也可），不传则只在终端显示
  --json            输出机器可读 JSON（不画终端二维码，便于脚本串联）
  -h, --help        显示本帮助

示例：
  # 项目根目录、服务已起着（一对一场景默认零参数：库里只有一名在册学生自动选）
  node .claude/skills/lecture-practice/scripts/lecture-qr.mjs
  # 库里多名学生时指定其一（姓名 / id / 登录名片段）
  node .claude/skills/lecture-practice/scripts/lecture-qr.mjs --student 张三
  # 开发态（Vite 5173），顺带存一张 SVG
  node .claude/skills/lecture-practice/scripts/lecture-qr.mjs --port 5173 --out ./qr.svg
`);
}

/**
 * 主流程。返回退出码：0 成功、1 运行期失败（库/学生/网卡问题）、2 用法错误或需二次选择。
 * interfaces 可注入，测试不碰真实网卡。
 * @param {string[]} [argv]
 * @param {{interfaces?: object}} [inject]
 */
export async function main(argv = process.argv.slice(2), inject = {}) {
  const interfaces = inject.interfaces ?? networkInterfaces();

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`参数错误：${err.message}\n`);
    printHelp();
    return 2;
  }
  if (opts.help) {
    printHelp();
    return 0;
  }

  let rows;
  try {
    rows = readStudents(resolve(opts.db));
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  const matched = matchStudents(rows, opts.student);
  if (matched.status === "empty") {
    console.error("库里还没有学生。先在教师端「学生」页新增学生。");
    return 1;
  }
  if (matched.status === "none") {
    console.error(`没有找到匹配「${opts.student}」的学生。`);
    return 1;
  }
  if (matched.status === "ambiguous") {
    console.error(
      `匹配到 ${matched.matches.length} 名学生，请用 --student 指定其中一个：`,
    );
    for (const student of matched.matches) {
      console.error(
        `  - ${student.displayName}（登录名 ${student.loginName}）id=${student.id}`,
      );
    }
    return 2;
  }

  const student = matched.student;
  const problem = studentLinkProblem(student);
  if (problem) {
    console.error(problem);
    return 1;
  }

  const candidates = pickLanAddresses(interfaces);
  const host = opts.host ?? candidates[0]?.address;
  if (!host) {
    console.error(
      "没有找到局域网 IPv4 地址：确认电脑已连 Wi-Fi/网线，或用 --host 指定本机 IP",
    );
    return 1;
  }

  let url;
  try {
    url = buildStudentUrl({ host, port: opts.port, token: student.linkToken });
  } catch (err) {
    console.error(`生成链接失败：${err.message}`);
    return 2;
  }

  let outPath = null;
  if (opts.out) {
    outPath = resolve(opts.out);
    try {
      if (extname(outPath).toLowerCase() === ".png") {
        const png = await QRCode.toBuffer(url, {
          type: "png",
          margin: 2,
          width: 480,
        });
        await writeFile(outPath, png);
      } else {
        const svg = await QRCode.toString(url, { type: "svg", margin: 2 });
        await writeFile(outPath, svg, "utf8");
      }
    } catch (err) {
      console.error(`写入二维码文件失败：${outPath}\n${err.message}`);
      return 1;
    }
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          student: {
            id: student.id,
            displayName: student.displayName,
            loginName: student.loginName,
          },
          url,
          file: outPath,
          candidates: candidates.map(
            (item) => `${item.address} (${item.iface})`,
          ),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(`学生：${student.displayName}（登录名 ${student.loginName}）`);
  console.log(`学生链接：${url}`);
  console.log("");
  console.log(await QRCode.toString(url, { type: "terminal" }));
  console.log("手机连同一 Wi-Fi 扫码直达学生端。");
  if (candidates.length > 1) {
    console.log(
      `其他可用地址：${candidates
        .slice(1)
        .map((item) => `${item.address} (${item.iface})`)
        .join("、")}（换一个用 --host）`,
    );
  }
  if (outPath) {
    console.log(`二维码文件：${outPath}`);
  }
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const code = await main();
  process.exitCode = code;
}
