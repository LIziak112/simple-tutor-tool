// lecture-qr 单测：地址枚举 / 链接拼接 / 学生匹配 / 参数解析四段纯逻辑，
// 外加一次真实 SQLite 只读读取的集成冒烟（临时库，不碰仓库 data/）。
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildStudentUrl,
  DEFAULT_DB,
  DEFAULT_PORT,
  main,
  matchStudents,
  parseArgs,
  pickLanAddresses,
  readStudents,
  studentLinkProblem,
} from "./lecture-qr.mjs";

/** 典型多网卡机器：回环、docker、veth、链路本地、IPv6 混杂 */
const fakeInterfaces = {
  lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
  veth9a: [{ address: "172.18.0.2", family: "IPv4", internal: false }],
  wlan0: [
    { address: "10.0.0.5", family: "IPv4", internal: false },
    { address: "192.168.1.23", family: "IPv4", internal: false },
    { address: "fe80::1", family: "IPv6", internal: false },
  ],
  // 老 Node 的 family 是数字 4
  eth0: [{ address: "169.254.10.1", family: 4, internal: false }],
  enp1s0: [{ address: "172.20.3.4", family: "IPv4", internal: false }],
};

function student(overrides = {}) {
  return {
    id: "stu-1",
    displayName: "张三",
    loginName: "zhangsan",
    linkToken: "tok-abc",
    linkEnabled: true,
    archivedAt: null,
    ...overrides,
  };
}

const tempDirs = [];
async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "lecture-qr-test-"));
  tempDirs.push(dir);
  return dir;
}

/** 造一个只有 students 表的临时库，列名与 apps/server/src/db/schema.ts 一致 */
async function makeDb(rows) {
  const dir = await makeTempDir();
  const dbPath = join(dir, "tutor.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE students (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    login_name TEXT NOT NULL,
    link_token TEXT,
    link_enabled INTEGER NOT NULL DEFAULT 1,
    archived_at TEXT
  )`);
  const insert = db.prepare(
    "INSERT INTO students (id, display_name, login_name, link_token, link_enabled, archived_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.displayName,
      row.loginName,
      row.linkToken,
      row.linkEnabled ? 1 : 0,
      row.archivedAt,
    );
  }
  db.close();
  return dbPath;
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

describe("pickLanAddresses", () => {
  it("排除回环、链路本地、虚拟网卡与 IPv6，只留够得着的 IPv4", () => {
    const addresses = pickLanAddresses(fakeInterfaces).map(
      (item) => item.address,
    );
    expect(addresses).toEqual(["192.168.1.23", "10.0.0.5", "172.20.3.4"]);
  });

  it("带上网卡名，便于老师判断是哪块网卡", () => {
    expect(pickLanAddresses(fakeInterfaces)[0]).toEqual({
      iface: "wlan0",
      address: "192.168.1.23",
    });
  });

  it("空输入不炸，返回空数组", () => {
    expect(pickLanAddresses({})).toEqual([]);
    expect(pickLanAddresses(undefined)).toEqual([]);
  });
});

describe("buildStudentUrl", () => {
  it("默认用服务端 8787 端口", () => {
    expect(buildStudentUrl({ host: "192.168.1.23", token: "AbC-123_x" })).toBe(
      "http://192.168.1.23:8787/s/AbC-123_x",
    );
  });

  it("开发态可指定 Vite 端口", () => {
    expect(
      buildStudentUrl({ host: "10.0.0.5", port: 5173, token: "tok" }),
    ).toBe("http://10.0.0.5:5173/s/tok");
  });

  it("token 两端的斜杠会被去掉，避免拼出 //s//", () => {
    expect(buildStudentUrl({ host: "10.0.0.5", token: "/tok/" })).toBe(
      "http://10.0.0.5:8787/s/tok",
    );
  });

  it("端口越界与空 token 直接报错", () => {
    expect(() =>
      buildStudentUrl({ host: "10.0.0.5", port: 0, token: "t" }),
    ).toThrow(/端口不合法/);
    expect(() =>
      buildStudentUrl({ host: "10.0.0.5", port: 70000, token: "t" }),
    ).toThrow(/端口不合法/);
    expect(() => buildStudentUrl({ host: "10.0.0.5", token: "  " })).toThrow(
      /缺少学生专属链接 token/,
    );
  });

  it("把整条链接误传给 token 时给出明确提示", () => {
    expect(() =>
      buildStudentUrl({ host: "10.0.0.5", token: "http://x/s/tok" }),
    ).toThrow(/不是整条链接/);
  });
});

describe("matchStudents", () => {
  it("库里只有一名在册学生时直取", () => {
    const result = matchStudents([student()], undefined);
    expect(result.status).toBe("single");
    expect(result.student.displayName).toBe("张三");
  });

  it("多名学生且未指定时要求二次选择", () => {
    const result = matchStudents(
      [
        student(),
        student({ id: "stu-2", displayName: "李四", loginName: "lisi" }),
      ],
      undefined,
    );
    expect(result.status).toBe("ambiguous");
    expect(result.matches).toHaveLength(2);
  });

  it("按姓名片段匹配（大小写不敏感）", () => {
    const result = matchStudents(
      [
        student(),
        student({ id: "stu-2", displayName: "李四", loginName: "lisi" }),
      ],
      "李",
    );
    expect(result.status).toBe("single");
    expect(result.student.id).toBe("stu-2");
  });

  it("按 id 前缀也能定位", () => {
    const result = matchStudents(
      [
        student(),
        student({ id: "stu-2", displayName: "李四", loginName: "lisi" }),
      ],
      "stu-2",
    );
    expect(result.status).toBe("single");
    expect(result.student.id).toBe("stu-2");
  });

  it("没人匹配 / 库里没学生 分别给出 none 与 empty", () => {
    expect(matchStudents([student()], "王五").status).toBe("none");
    expect(matchStudents([], undefined).status).toBe("empty");
  });

  it("归档学生不参与匹配", () => {
    const result = matchStudents(
      [student({ archivedAt: "2026-10-01T00:00:00Z" })],
      undefined,
    );
    expect(result.status).toBe("empty");
  });
});

describe("studentLinkProblem", () => {
  it("token 为空时提示去重置专属链接", () => {
    expect(studentLinkProblem(student({ linkToken: "" }))).toMatch(
      /重置专属链接/,
    );
  });

  it("专属链接登录关闭时提示打开", () => {
    expect(studentLinkProblem(student({ linkEnabled: false }))).toMatch(
      /已关闭/,
    );
  });

  it("正常学生没有问题", () => {
    expect(studentLinkProblem(student())).toBeNull();
  });
});

describe("parseArgs", () => {
  it("缺省端口 8787、缺省库为 ./data/tutor.db", () => {
    const opts = parseArgs([]);
    expect(opts.port).toBe(DEFAULT_PORT);
    expect(opts.db).toBe(DEFAULT_DB);
    expect(opts.json).toBe(false);
  });

  it("解析 student / port / db / out / json", () => {
    expect(
      parseArgs([
        "--student",
        "张三",
        "--port",
        "5173",
        "--db",
        "/tmp/x.db",
        "--out",
        "./qr.svg",
        "--json",
      ]),
    ).toMatchObject({
      student: "张三",
      port: 5173,
      db: "/tmp/x.db",
      out: "./qr.svg",
      json: true,
    });
  });

  it("未知参数、缺值、越界端口都抛错", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/未知参数/);
    expect(() => parseArgs(["--student"])).toThrow(/缺少取值/);
    expect(() => parseArgs(["--port", "0"])).toThrow(/1-65535/);
  });
});

describe("readStudents + main（真实 SQLite 只读）", () => {
  it("读到的列名与 schema 一致，并映射为驼峰字段", async () => {
    const dbPath = await makeDb([student()]);
    const rows = readStudents(dbPath);
    expect(rows).toEqual([
      {
        id: "stu-1",
        displayName: "张三",
        loginName: "zhangsan",
        linkToken: "tok-abc",
        linkEnabled: true,
        archivedAt: null,
      },
    ]);
  });

  it("库不存在时给出中文提示并返回 1", async () => {
    const errors = [];
    vi.spyOn(console, "error").mockImplementation((line) => {
      errors.push(String(line));
    });
    const code = await main(["--db", "/tmp/definitely-missing-lecture.db"], {
      interfaces: fakeInterfaces,
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/找不到数据库/);
  });

  it("--json 跑通全链：挑学生 → 拼 8787 链接 → 落 SVG", async () => {
    const dbPath = await makeDb([student()]);
    const dir = await makeTempDir();
    const outPath = join(dir, "qr.svg");
    const logs = [];
    vi.spyOn(console, "log").mockImplementation((line) => {
      logs.push(String(line));
    });

    const code = await main(["--db", dbPath, "--out", outPath, "--json"], {
      interfaces: fakeInterfaces,
    });

    expect(code).toBe(0);
    const payload = JSON.parse(logs.at(-1));
    expect(payload.url).toBe("http://192.168.1.23:8787/s/tok-abc");
    expect(payload.student.displayName).toBe("张三");
    expect(payload.file).toBe(outPath);
    const svg = await readFile(outPath, "utf8");
    expect(svg.startsWith("<svg")).toBe(true);
  });

  it("多名学生未指定时返回 2 并列出候选", async () => {
    const dbPath = await makeDb([
      student(),
      student({ id: "stu-2", displayName: "李四", loginName: "lisi" }),
    ]);
    const errors = [];
    vi.spyOn(console, "error").mockImplementation((line) => {
      errors.push(String(line));
    });
    const code = await main(["--db", dbPath], { interfaces: fakeInterfaces });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/请用 --student 指定/);
  });

  it("学生无 token 时返回 1 并提示重置", async () => {
    const dbPath = await makeDb([student({ linkToken: "" })]);
    const errors = [];
    vi.spyOn(console, "error").mockImplementation((line) => {
      errors.push(String(line));
    });
    const code = await main(["--db", dbPath], { interfaces: fakeInterfaces });
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/重置专属链接/);
  });

  it("库不是本项目结构（缺 students 表）时给中文错误", async () => {
    const dir = await makeTempDir();
    const dbPath = join(dir, "other.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE something_else(x TEXT)");
    db.close();
    expect(() => readStudents(dbPath)).toThrow(/读取 students 表失败/);
  });

  it("--out 目录不存在时返回 1 并给中文错误", async () => {
    const dbPath = await makeDb([student()]);
    const errors = [];
    vi.spyOn(console, "error").mockImplementation((line) => {
      errors.push(String(line));
    });
    const code = await main(
      ["--db", dbPath, "--out", "/tmp/definitely-missing-dir-xyz/qr.svg"],
      { interfaces: fakeInterfaces },
    );
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/写入二维码文件失败/);
  });

  it("没有局域网地址时返回 1", async () => {
    const dbPath = await makeDb([student()]);
    const errors = [];
    vi.spyOn(console, "error").mockImplementation((line) => {
      errors.push(String(line));
    });
    const code = await main(["--db", dbPath], {
      interfaces: {
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      },
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/没有找到局域网 IPv4/);
  });
});
