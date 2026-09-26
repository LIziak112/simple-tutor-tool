"""T2 server.py 单元测试。

运行方式（在项目根目录）：
    python -m unittest tests.test_server -v

所有测试类通过 make_server("127.0.0.1", 0, <临时数据目录>) 自起自停：
setUpClass 在后台线程启动 serve_forever，tearDownClass 中
shutdown() + server_close() + 删除临时目录，保证不残留监听端口与文件。

注意：kind=practice 的导入用例依赖 T1 的 parser.py；
parser.py 缺失或不可用时该用例自动 skip，其余用例不受影响。
"""

import importlib.util
import json
import re
import socket
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import server as server_module  # noqa: E402


# ---------------------------------------------------------------------------
# 探测 T1 的 parser.py 是否可用（与 server.load_parser 的探测逻辑保持一致）
# ---------------------------------------------------------------------------

def _parser_ready() -> bool:
    candidate = PROJECT_ROOT / "parser.py"
    if not candidate.is_file():
        return False
    try:
        import parser  # noqa: F401
        if callable(getattr(parser, "parse", None)):
            return True
    except Exception:
        pass
    try:
        spec = importlib.util.spec_from_file_location("_answer_parser_probe", candidate)
        if spec is None or spec.loader is None:
            return False
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return callable(getattr(module, "parse", None))
    except Exception:
        return False


PARSER_READY = _parser_ready()

# ---------------------------------------------------------------------------
# HTTP 测试工具
# ---------------------------------------------------------------------------

# 绕过系统代理，保证请求直达本机测试端口
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def http_request(method, url, payload=None, raw_body=None, headers=None, timeout=10):
    """发送 HTTP 请求，返回 (status, headers_dict, raw_bytes)。"""
    data = None
    hdrs = dict(headers or {})
    if raw_body is not None:
        data = raw_body
    elif payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json; charset=utf-8")
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with _OPENER.open(req, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()


def http_json(method, url, **kwargs):
    """发送请求并把响应体按 UTF-8 JSON 解析，返回 (status, headers, parsed)。"""
    status, headers, raw = http_request(method, url, **kwargs)
    parsed = None
    if raw:
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            parsed = None
    return status, headers, parsed


def raw_request(port, request_text, timeout=5):
    """用裸 socket 发送原始请求文本，返回原始响应字节（服务端 Connection: close）。"""
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as sock:
        sock.sendall(request_text.encode("utf-8"))
        buf = bytearray()
        while True:
            try:
                chunk = sock.recv(65536)
            except (socket.timeout, OSError):
                break
            if not chunk:
                break
            buf.extend(chunk)
    return bytes(buf)


def header(headers, name, default=""):
    """大小写不敏感地取响应头。"""
    for key, value in headers.items():
        if key.lower() == name.lower():
            return value
    return default


# ---------------------------------------------------------------------------
# 自起自停的服务器夹具
# ---------------------------------------------------------------------------

class ServerTestMixin:
    """setUpClass 启动临时服务器，tearDownClass 保证完全清理。

    public_mode：
      "default" —— 使用项目自带的 public/（这些用例不请求静态路径）
      "make"    —— 在临时目录新建 public/ 并写入已知文件（静态用例）
      "missing" —— 指向不存在的目录（验证服务仍可启动、API 可用）
    """

    public_mode = "default"

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory(prefix="quiz_server_test_")
        base = Path(cls._tmp.name)
        cls.data_dir = base / "data"      # 刻意不存在，验证自动创建
        if cls.public_mode == "make":
            cls.public_dir = base / "public"
        elif cls.public_mode == "missing":
            cls.public_dir = base / "no_such_public"
        else:
            cls.public_dir = None
        cls.server = server_module.make_server(
            "127.0.0.1", 0, str(cls.data_dir), public_dir=cls.public_dir
        )
        cls.port = cls.server.server_address[1]
        cls._thread = threading.Thread(
            target=cls.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        )
        cls._thread.start()

    @classmethod
    def tearDownClass(cls):
        try:
            cls.server.shutdown()
            cls._thread.join(timeout=5)
        finally:
            cls.server.server_close()   # 等待在途请求线程结束
        cls._tmp.cleanup()

    @classmethod
    def url(cls, path):
        return f"http://127.0.0.1:{cls.port}{path}"


# ---------------------------------------------------------------------------
# 测试数据
# ---------------------------------------------------------------------------

SAMPLE_CONTENT = {
    "version": 1,
    "lectures": [],
    "units": [
        {
            "id": "练习三",
            "unit": "练习三",
            "lecture": "第3讲",
            "topic": "有理数减法",
            "questions": [
                {
                    "id": "练习三-1",
                    "number": 1,
                    "difficulty": 1,
                    "type": "填空",
                    "knowledge": "有理数减法",
                    "stem": "计算：$3-5=$ ____。",
                    "options": [],
                    "answers": ["-2"],
                    "solutionMd": "【思路】小减大得负。",
                }
            ],
        }
    ],
}

# 契约 §4 的结构化练习 MD（含 UNIT 注释、两道题、;; 多空、详解 details）
PRACTICE_MD = """## 练习四
<!-- UNIT: 练习四|第4讲|有理数加法 -->

#### 题 1（★★）
【题型】计算
【考点】有理数减法-双负号
计算：$5-(-3)=$ ____。

<!-- ANSWER: 8 -->
<details>
<summary>参考答案</summary>

【思路】减去一个负数等于加上它的相反数。

</details>

#### 题 2（★）
【题型】判断
【考点】相反数的意义
判断：$-3$ 的相反数是 $3$。（　）

<!-- ANSWER: 正确 -->
"""


# ---------------------------------------------------------------------------
# 基础 API：health / content / import / 未知 API / 413
# ---------------------------------------------------------------------------

class TestBasicApi(ServerTestMixin, unittest.TestCase):

    def test_01_health(self):
        status, headers, body = http_json("GET", self.url("/api/health"))
        self.assertEqual(status, 200)
        self.assertEqual(header(headers, "Content-Type"), "application/json; charset=utf-8")
        self.assertTrue(body["ok"])
        self.assertTrue(re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z",
                                     body["time"]),
                        f"time 应为 ISO 格式：{body['time']!r}")

    def test_02_content_not_found(self):
        status, _, body = http_json("GET", self.url("/api/content"))
        self.assertEqual(status, 404)
        self.assertFalse(body["ok"])
        self.assertEqual(body["error"], "CONTENT_NOT_FOUND")

    def test_03_data_dir_auto_created(self):
        status, _, _ = http_json("GET", self.url("/api/health"))
        self.assertEqual(status, 200)
        self.assertTrue(self.data_dir.is_dir(), "数据目录应自动创建")
        self.assertTrue((self.data_dir / "submissions").is_dir(), "submissions 子目录应自动创建")
        self.assertFalse((self.data_dir / "content.json").exists(),
                         "content.json 不应被提前创建（否则 /api/content 无法返回 404）")

    def test_04_content_write_read(self):
        status, headers, body = http_json("POST", self.url("/api/content"), payload=SAMPLE_CONTENT)
        self.assertEqual(status, 200)
        self.assertEqual(header(headers, "Content-Type"), "application/json; charset=utf-8")
        self.assertEqual(body, {"ok": True})

        status, _, body = http_json("GET", self.url("/api/content"))
        self.assertEqual(status, 200)
        self.assertEqual(body, SAMPLE_CONTENT, "写后读应返回同一份 content")

    def test_05_content_post_rejects_invalid(self):
        cases = [
            ("非 JSON", b"this is not json"),
            ("空 body", b""),
            ("顶层数组", json.dumps([1, 2, 3]).encode("utf-8")),
            ("units 不是数组", json.dumps({"units": "oops"}, ensure_ascii=False).encode("utf-8")),
            ("单元缺少 id", json.dumps({"units": [{"questions": []}]}, ensure_ascii=False).encode("utf-8")),
            ("questions 不是数组", json.dumps({"units": [{"id": "u", "questions": "x"}]},
                                              ensure_ascii=False).encode("utf-8")),
        ]
        for name, raw in cases:
            with self.subTest(case=name):
                status, _, body = http_json("POST", self.url("/api/content"), raw_body=raw)
                self.assertEqual(status, 400, name)
                self.assertIsInstance(body, dict, name)
                self.assertFalse(body["ok"], name)

    @unittest.skipUnless(PARSER_READY, "parser.py（T1 交付物）尚未就绪——跳过 practice 导入用例")
    def test_06_import_practice(self):
        payload = {"kind": "practice", "filename": "有理数配套练习.md", "markdown": PRACTICE_MD}
        status, _, body = http_json("POST", self.url("/api/import"), payload=payload)
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        content = body["content"]
        self.assertIsInstance(content, dict)
        units = content["units"]
        self.assertIsInstance(units, list)

        target = next((u for u in units if isinstance(u, dict) and u.get("id") == "练习四"), None)
        self.assertIsNotNone(target, f"应合并出 id=练习四 的单元，实际 units={units!r}")
        self.assertIsInstance(target["questions"], list)
        self.assertGreaterEqual(len(target["questions"]), 1)
        for question in target["questions"]:
            self.assertTrue(isinstance(question.get("id"), str) and question["id"],
                            "每道题应有非空 id")
            self.assertIn("stem", question)
            self.assertIsInstance(question.get("answers"), list)
        first = target["questions"][0]
        self.assertIn("8", [str(a) for a in first.get("answers", [])],
                      "题 1 的答案应解析出 8")

        # 合并而非整库替换：此前 POST /api/content 写入的“练习三”仍在
        self.assertTrue(any(isinstance(u, dict) and u.get("id") == "练习三" for u in units),
                        f"已有单元不应被 practice 导入覆盖，实际 units={units!r}")

    def test_07_import_lecture_add_and_replace(self):
        title = "第 4 讲 加法——方向参与的合并"
        md1 = "# 第 4 讲 加法\n\n用方向参与的观点理解合并。"
        status, _, body = http_json("POST", self.url("/api/import"),
                                    payload={"kind": "lecture", "title": title, "markdown": md1})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        lectures = body["content"]["lectures"]
        matched = [lec for lec in lectures if lec.get("title") == title]
        self.assertEqual(len(matched), 1)
        self.assertRegex(matched[0]["id"], r"^lec-\d+$")
        self.assertEqual(matched[0]["markdown"], md1)

        # 同 title 再导入 → 替换而非新增
        md2 = md1 + "\n\n## 补充例题\n"
        status, _, body = http_json("POST", self.url("/api/import"),
                                    payload={"kind": "lecture", "title": title, "markdown": md2})
        self.assertEqual(status, 200)
        lectures = body["content"]["lectures"]
        matched = [lec for lec in lectures if lec.get("title") == title]
        self.assertEqual(len(matched), 1, "同 title 再导入应替换原有讲义")
        self.assertEqual(matched[0]["markdown"], md2)

    def test_08_import_content_whole_replace(self):
        full = {
            "version": 1,
            "lectures": [{"id": "lec-1", "title": "临时讲义", "markdown": "# 临时讲义"}],
            "units": [{
                "id": "练习五",
                "unit": "练习五",
                "lecture": "第5讲",
                "topic": "有理数乘除法",
                "questions": [{
                    "id": "练习五-1",
                    "number": 1,
                    "difficulty": 2,
                    "type": "选择",
                    "knowledge": "符号法则",
                    "stem": "(-2)×3=____。",
                    "options": [],
                    "answers": ["-6"],
                    "solutionMd": "【思路】异号得负。",
                }],
            }],
        }
        status, _, body = http_json("POST", self.url("/api/import"),
                                    payload={"kind": "content", "content": full})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["content"], full)

        status, _, body = http_json("GET", self.url("/api/content"))
        self.assertEqual(status, 200)
        self.assertEqual(body, full, "整库替换后 GET /api/content 应返回新库")

        # 未知 kind → 400
        status, _, body = http_json("POST", self.url("/api/import"), payload={"kind": "wat"})
        self.assertEqual(status, 400)
        self.assertFalse(body["ok"])

    def test_09_unknown_api_returns_404_json(self):
        status, _, body = http_json("GET", self.url("/api/what"))
        self.assertEqual(status, 404)
        self.assertFalse(body["ok"])

        status, headers, body = http_json("POST", self.url("/api/what"), payload={})
        self.assertEqual(status, 404)
        self.assertFalse(body["ok"])
        self.assertEqual(header(headers, "Content-Type"), "application/json; charset=utf-8")

    def test_10_body_too_large_413(self):
        big = b"x" * (25 * 1024 * 1024 + 1024)  # 略超 25MB
        status, headers, body = http_json("POST", self.url("/api/submit"), raw_body=big,
                                          headers={"Content-Type": "application/json; charset=utf-8"})
        self.assertEqual(status, 413)
        self.assertEqual(header(headers, "Content-Type"), "application/json; charset=utf-8")
        self.assertFalse(body["ok"])


# ---------------------------------------------------------------------------
# 提交记录：submit / submissions 倒序 / grade
# ---------------------------------------------------------------------------

class TestSubmissionsApi(ServerTestMixin, unittest.TestCase):

    def _make_record(self, student, submitted_at=None, questions=None):
        record = {
            "version": 1,
            "student": student,
            "unitId": "练习四",
            "unitName": "有理数加法",
            "durationSec": 600,
            "device": "ipad",
            "questions": questions if questions is not None else [
                {
                    "id": "练习四-1",
                    "number": 1,
                    "type": "计算",
                    "textAnswer": "8",
                    "correct": True,
                    "autoGraded": True,
                    "strokesPng": None,
                    "timeSec": 45,
                    "teacherMark": None,
                    "teacherComment": None,
                }
            ],
        }
        if submitted_at is not None:
            record["submittedAt"] = submitted_at
        return record

    def _post_submit(self, record):
        return http_json("POST", self.url("/api/submit"), payload=record)

    def test_00_empty_list(self):
        status, _, body = http_json("GET", self.url("/api/submissions"))
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["submissions"], [])

    def test_01_submit_saves_and_sanitizes_filename(self):
        record = self._make_record("小马:虎/测 试*坏?名字", submitted_at="2026-09-01T08:00:00.000Z")
        status, _, body = self._post_submit(record)
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        fname = body["file"]
        self.assertRegex(fname, r"^小马_虎_测_试_坏_名字-\d{8}-\d{6}-[0-9A-F]{4}\.json$",
                         "非法字符与空白应净化为 _，文件名应含时间戳与 4 位随机串")

        path = self.data_dir / "submissions" / fname
        self.assertTrue(path.is_file(), "提交记录应落盘到 data/submissions/")
        on_disk = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(on_disk, record, "落盘内容应与提交内容一致")

        # 缺 student / 缺 questions → 400
        status, _, body = self._post_submit(self._make_record(""))
        self.assertEqual(status, 400)
        self.assertFalse(body["ok"])

        bad = self._make_record("无题目")
        del bad["questions"]
        status, _, body = self._post_submit(bad)
        self.assertEqual(status, 400)
        self.assertFalse(body["ok"])

    def test_02_submissions_sorted_by_submittedat_desc(self):
        made = [
            ("提交甲", "2026-01-01T08:00:00.000Z"),
            ("提交丙", "2026-03-01T08:00:00.000Z"),  # 最新
            ("提交乙", "2026-02-01T08:00:00.000Z"),
        ]
        for student, ts in made:
            status, _, _ = self._post_submit(self._make_record(student, submitted_at=ts))
            self.assertEqual(status, 200)

        status, _, body = http_json("GET", self.url("/api/submissions"))
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        names = [s["record"]["student"] for s in body["submissions"]
                 if s["record"]["student"].startswith("提交")]
        self.assertEqual(names, ["提交丙", "提交乙", "提交甲"], "应按 submittedAt 倒序")

    def test_03_grade_updates_record(self):
        questions = [
            {"id": "练习四-1", "number": 1, "type": "计算", "textAnswer": "8",
             "correct": True, "autoGraded": True, "strokesPng": None, "timeSec": 45,
             "teacherMark": None, "teacherComment": None},
            {"id": "练习四-2", "number": 2, "type": "应用", "textAnswer": "",
             "correct": None, "autoGraded": None, "strokesPng": None, "timeSec": 120,
             "teacherMark": None, "teacherComment": None},
        ]
        record = self._make_record("批注对象", submitted_at="2026-05-01T08:00:00.000Z",
                                   questions=questions)
        status, _, body = self._post_submit(record)
        self.assertEqual(status, 200)
        fname = body["file"]

        status, _, body = http_json("POST", self.url("/api/grade"), payload={
            "file": fname,
            "questionId": "练习四-2",
            "teacherMark": "错误",
            "teacherComment": "注意符号，再检查一遍",
        })
        self.assertEqual(status, 200)
        self.assertEqual(body, {"ok": True})

        status, _, body = http_json("GET", self.url("/api/submissions"))
        entry = next(s for s in body["submissions"] if s["file"] == fname)
        by_id = {q["id"]: q for q in entry["record"]["questions"]}
        self.assertEqual(by_id["练习四-2"]["teacherMark"], "错误")
        self.assertEqual(by_id["练习四-2"]["teacherComment"], "注意符号，再检查一遍")
        # 其他题不受影响
        self.assertIsNone(by_id["练习四-1"]["teacherMark"])
        self.assertIsNone(by_id["练习四-1"]["teacherComment"])

    def test_04_grade_rejects_bad_requests(self):
        status, _, body = self._post_submit(
            self._make_record("批注错误", submitted_at="2026-05-02T08:00:00.000Z"))
        self.assertEqual(status, 200)
        fname = body["file"]

        cases = [
            ({"file": "不存在.json", "questionId": "练习四-1", "teacherMark": "正确"}, 404),
            ({"file": fname, "questionId": "练习四-999", "teacherMark": "正确"}, 404),
            ({"file": fname, "questionId": "练习四-1", "teacherMark": "maybe"}, 400),
            ({"file": "", "questionId": "练习四-1", "teacherMark": "正确"}, 400),
            ({"file": fname, "teacherMark": "正确"}, 400),
            ({"file": "../escape.json", "questionId": "练习四-1", "teacherMark": "正确"}, 400),
        ]
        for payload, expect in cases:
            with self.subTest(payload=payload):
                status, _, body = http_json("POST", self.url("/api/grade"), payload=payload)
                self.assertEqual(status, expect)
                self.assertFalse(body["ok"])


# ---------------------------------------------------------------------------
# 静态文件服务
# ---------------------------------------------------------------------------

class TestStaticFiles(ServerTestMixin, unittest.TestCase):
    public_mode = "make"

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        root = Path(cls._tmp.name) / "public"
        (root / "js").mkdir(parents=True, exist_ok=True)
        (root / "sub").mkdir(parents=True, exist_ok=True)
        (root / "index.html").write_text("<h1>线上答题系统</h1>", encoding="utf-8")
        (root / "style.css").write_text("body { color: #222; }", encoding="utf-8")
        (root / "js" / "app.js").write_text("console.log('quiz');", encoding="utf-8")
        (root / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\nfakepngbytes")

    def _raw_get(self, target):
        request = f"GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
        return raw_request(self.port, request)

    def test_01_root_serves_index(self):
        status, headers, raw = http_request("GET", self.url("/"))
        self.assertEqual(status, 200)
        self.assertTrue(header(headers, "Content-Type").startswith("text/html"))
        self.assertIn("线上答题系统".encode("utf-8"), raw)

        status, _, raw = http_request("GET", self.url("/index.html"))
        self.assertEqual(status, 200)

    def test_02_mime_types(self):
        cases = [
            ("/js/app.js", "javascript"),
            ("/style.css", "text/css"),
            ("/logo.png", "image/png"),
        ]
        for target, expected in cases:
            with self.subTest(target=target):
                status, headers, _ = http_request("GET", self.url(target))
                self.assertEqual(status, 200)
                self.assertIn(expected, header(headers, "Content-Type"))

    def test_03_missing_file_returns_404_json(self):
        status, headers, body = http_json("GET", self.url("/nope.js"))
        self.assertEqual(status, 404)
        self.assertFalse(body["ok"])
        self.assertEqual(header(headers, "Content-Type"), "application/json; charset=utf-8")

    def test_04_no_directory_listing(self):
        for target in ("/js", "/js/", "/sub", "/sub/"):
            with self.subTest(target=target):
                status, _, body = http_json("GET", self.url(target))
                self.assertEqual(status, 404, target)
                self.assertFalse(body["ok"], target)

    def test_05_rejects_path_traversal(self):
        # 先确认裸 socket 通道正常
        first = self._raw_get("/index.html")
        self.assertTrue(first.startswith(b"HTTP/1.1 200"), first[:64])

        targets = [
            "/../server.py",
            "/../../server.py",
            "/..%2fserver.py",
            "/%2e%2e/server.py",
            "/js/%2e%2e/%2e%2e/server.py",
            "/js/..%5c..%5cserver.py",
            "/%2e%2e/tests/test_server.py",
        ]
        for target in targets:
            with self.subTest(target=target):
                resp = self._raw_get(target)
                status_line = resp.split(b"\r\n", 1)[0]
                self.assertTrue(status_line.startswith(b"HTTP/1.1 404"),
                                f"{target} => {status_line!r}")
                self.assertNotIn(b"ThreadingHTTPServer", resp, "不得泄漏 server.py 源码")

        # urllib 走一遍编码穿越（客户端不归一化点段时同样要拒绝）
        status, _, body = http_json("GET", self.url("/%2e%2e/server.py"))
        self.assertEqual(status, 404)
        self.assertFalse(body["ok"])

    def test_06_post_static_not_allowed(self):
        status, headers, body = http_json("POST", self.url("/"), payload={"x": 1})
        self.assertEqual(status, 405)
        self.assertFalse(body["ok"])
        self.assertEqual(header(headers, "Content-Type"), "application/json; charset=utf-8")


# ---------------------------------------------------------------------------
# public/ 缺失时服务仍可启动、API 可用
# ---------------------------------------------------------------------------

class TestPublicMissingStillServesApi(ServerTestMixin, unittest.TestCase):
    public_mode = "missing"

    def test_01_api_works_without_public(self):
        status, _, body = http_json("GET", self.url("/api/health"))
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])

    def test_02_static_missing_returns_404_json(self):
        status, _, body = http_json("GET", self.url("/"))
        self.assertEqual(status, 404)
        self.assertFalse(body["ok"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
