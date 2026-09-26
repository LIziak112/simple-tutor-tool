"""线上答题系统 —— 后端服务（T2 交付物）。

提供：静态文件服务（public/）+ JSON API + 文件存储（content.json 与 submissions/*.json）。
仅使用 Python 标准库。接口契约见 docs/01_任务安排与契约.md 第 3 节。

模块用法（供测试导入）：
    import server
    srv = server.make_server("127.0.0.1", 0, "临时数据目录")  # 端口 0 = 系统自动分配
    host, port = srv.server_address[:2]

命令行用法：
    python server.py [--host 0.0.0.0] [--port 8787] [--data ./data]
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import random
import re
import socket
import sys
import tempfile
import threading
import traceback
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

# ---------------------------------------------------------------------------
# 常量与通用工具
# ---------------------------------------------------------------------------

ROOT_DIR = Path(__file__).resolve().parent      # 项目根（server.py 所在目录）
DEFAULT_PUBLIC_DIR = ROOT_DIR / "public"        # 静态文件目录
MAX_BODY_BYTES = 25 * 1024 * 1024               # JSON 请求体上限：25 MB
MAX_DRAIN_BYTES = 64 * 1024 * 1024              # 超限时最多预读丢弃的字节数

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}

# 文件名净化：契约规定 [\\/:*?"<>|] 及空白 → "_"
_SANITIZE_RE = re.compile(r'[\\/:*?"<>|\s]+')


def utc_now_iso() -> str:
    """当前 UTC 时间的 ISO 字符串，如 2026-09-24T12:00:00.000Z。"""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def sanitize_filename(name: str, fallback: str = "unnamed") -> str:
    """把非法文件名字符与空白替换为 "_"；净化后为空时用 fallback。"""
    cleaned = _SANITIZE_RE.sub("_", str(name))
    if not cleaned or cleaned in {".", ".."}:
        cleaned = fallback
    return cleaned


def parse_iso_datetime(value):
    """尽力解析 ISO 时间字符串；失败返回 None。"""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _atomic_write_text(path: Path, text: str) -> None:
    """UTF-8（无 BOM）原子写入，避免并发请求读到半个文件。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# 错误类型
# ---------------------------------------------------------------------------

class ApiError(Exception):
    """业务错误：携带 HTTP 状态码与机器可读错误码。"""

    def __init__(self, status: int, error: str, message: str | None = None):
        super().__init__(message or error)
        self.status = status
        self.error = error
        self.message = message or error


class BodyTooLarge(Exception):
    """请求体超过 25MB 上限。"""


class StaticNotFound(Exception):
    """静态文件不可用（不存在/非法路径/目录）。"""


# ---------------------------------------------------------------------------
# content.json 结构处理
# ---------------------------------------------------------------------------

def validate_content(content) -> str | None:
    """校验 content.json 结构；返回错误说明，None 表示合法。"""
    if not isinstance(content, dict):
        return "content 必须是 JSON 对象"
    if "version" in content and not isinstance(content["version"], int):
        return "version 必须是整数"
    for key in ("lectures", "units"):
        if key in content and not isinstance(content[key], list):
            return f"{key} 必须是数组"
    for idx, unit in enumerate(content.get("units") or []):
        if not isinstance(unit, dict):
            return f"units[{idx}] 必须是对象"
        unit_id = unit.get("id")
        if not isinstance(unit_id, str) or not unit_id.strip():
            return f"units[{idx}].id 缺失或为空"
        if "questions" in unit and not isinstance(unit["questions"], list):
            return f"units[{idx}].questions 必须是数组"
    for idx, lecture in enumerate(content.get("lectures") or []):
        if not isinstance(lecture, dict):
            return f"lectures[{idx}] 必须是对象"
    return None


def normalize_content(content: dict) -> dict:
    """补全 content 顶层缺省字段（version/lectures/units）。"""
    merged = dict(content)
    merged.setdefault("version", 1)
    merged["lectures"] = merged.get("lectures") or []
    merged["units"] = merged.get("units") or []
    if not isinstance(merged["lectures"], list) or not isinstance(merged["units"], list):
        raise ValueError("lectures/units 必须是数组")
    return merged


def next_lecture_id(lectures) -> str:
    """按已有 lec-<n> 的最大序号 +1 生成新讲义 id。"""
    max_seen = 0
    for lec in lectures:
        match = re.fullmatch(r"lec-(\d+)", str((lec or {}).get("id", "")))
        if match:
            max_seen = max(max_seen, int(match.group(1)))
    return f"lec-{max_seen + 1}"


# "第 X 讲"标题：兼容 H2/H3（实际数据里存在个别讲写成 H3 的情况）
_LECTURE_HEADING_RE = re.compile(r"^(#{2,3})[ \t]+(第\s*\d+\s*讲[^\n]*)$", re.M)


def split_lecture_markdown(markdown: str):
    """将包含多个"第 X 讲"标题的讲义切分为 [(title, markdown), ...]。

    命中不足 2 处返回 None（调用方按整篇单讲处理）。
    第一处"第 X 讲"之前的前言单独成讲（标题取 H1，无 H1 则"前言"）。
    每讲保留原正文，首行标题统一规范为 H2。
    """
    matches = list(_LECTURE_HEADING_RE.finditer(markdown))
    if len(matches) < 2:
        return None
    pieces = []
    preamble = markdown[:matches[0].start()].strip("\n")
    if preamble.strip():
        h1 = re.search(r"^#[ \t]+(.+)$", preamble, re.M)
        pieces.append(((h1.group(1).strip() if h1 else "前言"), preamble))
    for i, m in enumerate(matches):
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(markdown)
        title = m.group(2).strip()
        body = "## " + title + markdown[start + len(m.group(0)):end].rstrip("\n")
        # 上一段末尾的<hr>（---）留在上一讲内无意义，剥掉尾部孤立的分隔线
        if pieces:
            prev_t, prev_md = pieces[-1]
            pieces[-1] = (prev_t, re.sub(r"\n-{3,}[ \t]*\n?\Z", "\n", prev_md))
        pieces.append((title, body))
    return pieces


# ---------------------------------------------------------------------------
# 文件存储
# ---------------------------------------------------------------------------

class DataStore:
    """content.json 与 submissions/ 的线程安全文件存储。"""

    def __init__(self, data_dir):
        self.data_dir = Path(data_dir)
        self.submissions_dir = self.data_dir / "submissions"
        self.lock = threading.RLock()
        self.ensure_dirs()

    def ensure_dirs(self) -> None:
        """数据目录不存在则自动创建。

        只创建目录，不预建 content.json —— 保证“不存在时 GET /api/content 返回 404”。
        """
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.submissions_dir.mkdir(parents=True, exist_ok=True)

    # ---------- content.json ----------

    @property
    def content_path(self) -> Path:
        return self.data_dir / "content.json"

    def read_content(self):
        """读取 content.json；不存在返回 None；文件损坏抛 ValueError。"""
        with self.lock:
            if not self.content_path.exists():
                return None
            text = self.content_path.read_text(encoding="utf-8")
        return json.loads(text)

    def write_content(self, content: dict) -> None:
        _atomic_write_text(self.content_path, json.dumps(content, ensure_ascii=False, indent=2))

    def load_or_init_content(self) -> dict:
        content = self.read_content()
        if content is None:
            return {"version": 1, "lectures": [], "units": []}
        if not isinstance(content, dict):
            raise ValueError("content.json 顶层必须是 JSON 对象")
        return content

    def import_units(self, units) -> dict:
        """按 unit id 合并（同 id 整体替换），返回最新 content 全文。"""
        with self.lock:
            merged = normalize_content(self.load_or_init_content())
            units_list = merged["units"]
            index_by_id = {}
            for idx, unit in enumerate(units_list):
                if isinstance(unit, dict) and isinstance(unit.get("id"), str):
                    index_by_id[unit["id"]] = idx
            for unit in units:
                unit_id = unit["id"]
                if unit_id in index_by_id:
                    units_list[index_by_id[unit_id]] = unit
                else:
                    index_by_id[unit_id] = len(units_list)
                    units_list.append(unit)
            self.write_content(merged)
            return merged

    def import_lecture(self, title: str, markdown: str) -> dict:
        """按 title 追加/替换讲义（id 自动编 lec-<n>），返回最新 content 全文。"""
        with self.lock:
            merged = normalize_content(self.load_or_init_content())
            target = None
            for lec in merged["lectures"]:
                if isinstance(lec, dict) and lec.get("title") == title:
                    target = lec
                    break
            if target is None:
                target = {"id": next_lecture_id(merged["lectures"]), "title": title}
                merged["lectures"].append(target)
            target["title"] = title
            target["markdown"] = markdown
            self.write_content(merged)
            return merged

    def import_lecture_smart(self, title: str, markdown: str) -> dict:
        """讲义导入：含多个"第 X 讲"标题时自动切分为多条讲义（同题替换），否则按单讲处理。"""
        pieces = split_lecture_markdown(markdown)
        if not pieces:
            return self.import_lecture(title, markdown)
        with self.lock:
            merged = normalize_content(self.load_or_init_content())
            for piece_title, piece_md in pieces:
                target = None
                for lec in merged["lectures"]:
                    if isinstance(lec, dict) and lec.get("title") == piece_title:
                        target = lec
                        break
                if target is None:
                    target = {"id": next_lecture_id(merged["lectures"]), "title": piece_title}
                    merged["lectures"].append(target)
                target["title"] = piece_title
                target["markdown"] = piece_md
            self.write_content(merged)
            return merged

    def replace_content(self, content: dict) -> dict:
        """整库替换 content.json，返回写入内容。"""
        with self.lock:
            self.write_content(content)
            return content

    # ---------- submissions ----------

    def save_submission(self, record: dict) -> str:
        """落盘提交记录：<净化学生名>-<yyyymmdd-HHMMSS>-<4位随机>.json，返回文件名。"""
        base = sanitize_filename(str(record.get("student") or "unknown"), "unknown")
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        payload = json.dumps(record, ensure_ascii=False, indent=2)
        self.ensure_dirs()
        with self.lock:
            for _ in range(20):
                rand4 = "".join(random.choices("0123456789ABCDEF", k=4))
                name = f"{base}-{stamp}-{rand4}.json"
                path = self.submissions_dir / name
                try:
                    fd = os.open(str(path), os.O_CREAT | os.O_WRONLY | os.O_EXCL)
                except FileExistsError:
                    continue  # 同秒同名冲突，换随机串重试
                with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
                    fh.write(payload)
                return name
        raise OSError("无法生成唯一的提交文件名")

    def list_submissions(self):
        """返回 [(文件名, record)]，按 submittedAt 倒序；损坏文件跳过。"""
        self.ensure_dirs()
        items = []
        with self.lock:
            for path in sorted(self.submissions_dir.glob("*.json")):
                try:
                    record = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                if isinstance(record, dict):
                    items.append((path.name, record))
        items.sort(key=self._submission_sort_key, reverse=True)
        return items

    @staticmethod
    def _submission_sort_key(item):
        name, record = item
        parsed = parse_iso_datetime(record.get("submittedAt"))
        if parsed is None:
            parsed = datetime.min.replace(tzinfo=timezone.utc)
        return (parsed, name)

    def grade_submission(self, filename: str, question_id: str, teacher_mark, teacher_comment) -> str:
        """按 file + questionId 更新对应题的 teacherMark / teacherComment。

        返回 "OK" / "SUBMISSION_NOT_FOUND" / "SUBMISSION_CORRUPT" / "QUESTION_NOT_FOUND"。
        """
        self.ensure_dirs()
        path = self.submissions_dir / filename
        with self.lock:
            if not path.is_file():
                return "SUBMISSION_NOT_FOUND"
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return "SUBMISSION_CORRUPT"
            if not isinstance(record, dict) or not isinstance(record.get("questions"), list):
                return "SUBMISSION_CORRUPT"
            target = None
            for question in record["questions"]:
                if isinstance(question, dict) and question.get("id") == question_id:
                    target = question
                    break
            if target is None:
                return "QUESTION_NOT_FOUND"
            target["teacherMark"] = teacher_mark
            target["teacherComment"] = teacher_comment
            _atomic_write_text(path, json.dumps(record, ensure_ascii=False, indent=2))
        return "OK"


# ---------------------------------------------------------------------------
# parser.py 加载（T1 交付物，允许缺失）
# ---------------------------------------------------------------------------

def load_parser():
    """加载 T1 的 parser.py 并返回模块；未就绪/损坏时返回 None（绝不抛异常）。"""
    try:
        import parser as parser_module  # 项目根目录下的 parser.py
        if callable(getattr(parser_module, "parse", None)):
            return parser_module
    except Exception:
        pass
    candidate = ROOT_DIR / "parser.py"
    if candidate.is_file():
        try:
            spec = importlib.util.spec_from_file_location("answer_parser", candidate)
            if spec is not None and spec.loader is not None:
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                if callable(getattr(module, "parse", None)):
                    sys.modules.setdefault("answer_parser", module)
                    return module
        except Exception:
            return None
    return None


# ---------------------------------------------------------------------------
# 静态文件
# ---------------------------------------------------------------------------

def _resolve_static_path(public_dir: Path, url_path: str) -> Path:
    """把 URL 路径解析为 public/ 内的真实文件；非法/不存在时抛 StaticNotFound。"""
    if not url_path.startswith("/") or "\x00" in url_path:
        raise StaticNotFound()
    segments = []
    for seg in url_path.split("/"):
        if seg in ("", "."):
            continue
        if ".." in seg or "\\" in seg or ":" in seg:
            raise StaticNotFound()  # 拒绝路径穿越与盘符
        segments.append(seg)
    if not segments:
        target = public_dir / "index.html"      # 根路径默认 index.html
    else:
        target = public_dir.joinpath(*segments)
        if target.is_dir():                     # 目录：只允许其中的 index.html，绝不列目录
            target = target / "index.html"
    try:
        resolved = target.resolve()
        resolved.relative_to(public_dir.resolve())  # 双保险：必须仍在 public/ 内
    except (ValueError, OSError):
        raise StaticNotFound()
    if not resolved.is_file():
        raise StaticNotFound()
    return resolved


# ---------------------------------------------------------------------------
# HTTP 处理器
# ---------------------------------------------------------------------------

class QuizRequestHandler(BaseHTTPRequestHandler):
    server_version = "QuizServer/1.0"
    protocol_version = "HTTP/1.1"
    timeout = 60  # 单请求读超时，防止慢/坏客户端长期占住线程

    # ---------- 响应工具 ----------

    def _send_json(self, status: int, payload: dict, close: bool = False) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if close:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    # ---------- 请求体读取 ----------

    def _read_body(self) -> bytes:
        """读取请求体，超过 25MB 抛 BodyTooLarge。"""
        transfer_encoding = (self.headers.get("Transfer-Encoding") or "").lower()
        if "chunked" in transfer_encoding:
            return self._read_chunked_body()
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            return b""
        try:
            length = int(raw_length)
        except ValueError:
            self.close_connection = True
            raise ApiError(400, "INVALID_CONTENT_LENGTH", "Content-Length 不合法")
        if length < 0:
            self.close_connection = True
            raise ApiError(400, "INVALID_CONTENT_LENGTH", "Content-Length 不合法")
        if length > MAX_BODY_BYTES:
            # 预读并丢弃一部分数据，避免客户端还在发送时立即关闭连接（RST）
            # 导致客户端读不到 413 响应。
            remaining = min(length, MAX_DRAIN_BYTES)
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 65536))
                if not chunk:
                    break
                remaining -= len(chunk)
            raise BodyTooLarge()
        chunks = []
        remaining = length
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 65536))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        body = b"".join(chunks)
        if len(body) > MAX_BODY_BYTES:  # 双保险，理论上到不了
            raise BodyTooLarge()
        return body

    def _read_chunked_body(self) -> bytes:
        chunks = []
        total = 0
        while True:
            size_line = self.rfile.readline(1024)
            if not size_line:
                raise ApiError(400, "INVALID_REQUEST_BODY", "chunked 编码不完整")
            try:
                size = int(size_line.strip().split(b";")[0], 16)
            except ValueError:
                raise ApiError(400, "INVALID_REQUEST_BODY", "chunked 大小行不合法")
            if size == 0:
                while True:  # 吃掉 trailer 到空行
                    trailer = self.rfile.readline(1024)
                    if trailer in (b"\r\n", b"\n", b""):
                        break
                break
            total += size
            if total > MAX_BODY_BYTES:
                self.close_connection = True
                raise BodyTooLarge()
            data = self.rfile.read(size)
            if len(data) != size:
                raise ApiError(400, "INVALID_REQUEST_BODY", "chunked 数据不完整")
            chunks.append(data)
            self.rfile.read(2)  # 每块后的 CRLF
        return b"".join(chunks)

    def _read_json_body(self):
        raw = self._read_body()
        if not raw:
            raise ApiError(400, "EMPTY_BODY", "请求体不能为空")
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise ApiError(400, "INVALID_JSON", "请求体不是合法的 UTF-8 JSON")

    # ---------- 日志 ----------

    def log_request(self, code="-", size="-"):
        """只记录 4xx/5xx，正常请求不刷屏。"""
        try:
            noisy = int(code) >= 400
        except (TypeError, ValueError):
            noisy = True
        if noisy:
            super().log_request(code, size)

    # ---------- GET ----------

    def do_GET(self):
        try:
            self._do_get()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True

    def _do_get(self):
        path = unquote(urlsplit(self.path).path)
        try:
            if path.startswith("/api/"):
                self._route_api_get(path)
            else:
                self._handle_static(path)
        except ApiError as exc:
            self._send_json(exc.status, {"ok": False, "error": exc.error, "message": exc.message})
        except (BrokenPipeError, ConnectionResetError):
            raise
        except Exception:
            traceback.print_exc()
            self._send_json(500, {"ok": False, "error": "INTERNAL_ERROR", "message": "服务器内部错误"})

    def _route_api_get(self, path: str) -> None:
        if path == "/api/health":
            self._send_json(200, {"ok": True, "time": utc_now_iso()})
        elif path == "/api/content":
            content = self.server.data_store.read_content()
            if content is None:
                self._send_json(404, {"ok": False, "error": "CONTENT_NOT_FOUND",
                                      "message": "content.json 不存在，请先导入内容"})
            else:
                self._send_json(200, content)
        elif path == "/api/submissions":
            items = self.server.data_store.list_submissions()
            payload = [{"file": name, "record": record} for name, record in items]
            self._send_json(200, {"ok": True, "submissions": payload})
        else:
            self._send_json(404, {"ok": False, "error": "NOT_FOUND", "message": f"未知 API：{path}"})

    def _handle_static(self, path: str) -> None:
        public_dir = self.server.public_dir
        if not public_dir.is_dir():
            self._send_json(404, {"ok": False, "error": "NOT_FOUND", "message": "静态目录不存在"})
            return
        try:
            file_path = _resolve_static_path(public_dir, path)
        except StaticNotFound:
            self._send_json(404, {"ok": False, "error": "NOT_FOUND", "message": "文件不存在"})
            return
        try:
            data = file_path.read_bytes()
        except OSError:
            self._send_json(404, {"ok": False, "error": "NOT_FOUND", "message": "文件不可读"})
            return
        content_type = MIME_TYPES.get(file_path.suffix.lower(), "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    # ---------- POST ----------

    def do_POST(self):
        try:
            self._do_post()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True

    def _do_post(self):
        path = unquote(urlsplit(self.path).path)
        try:
            if path.startswith("/api/"):
                self._route_api_post(path)
            else:
                self._read_body()  # 丢弃请求体，保持协议状态一致
                self._send_json(405, {"ok": False, "error": "METHOD_NOT_ALLOWED",
                                      "message": "静态资源仅支持 GET"}, close=True)
        except BodyTooLarge:
            self._send_json(413, {"ok": False, "error": "BODY_TOO_LARGE",
                                  "message": "请求体超过 25MB 上限"}, close=True)
        except ApiError as exc:
            self._send_json(exc.status, {"ok": False, "error": exc.error, "message": exc.message})
        except (BrokenPipeError, ConnectionResetError):
            raise
        except Exception:
            traceback.print_exc()
            self._send_json(500, {"ok": False, "error": "INTERNAL_ERROR", "message": "服务器内部错误"})

    def _route_api_post(self, path: str) -> None:
        if path == "/api/content":
            self._api_post_content()
        elif path == "/api/import":
            self._api_post_import()
        elif path == "/api/submit":
            self._api_post_submit()
        elif path == "/api/grade":
            self._api_post_grade()
        else:
            self._send_json(404, {"ok": False, "error": "NOT_FOUND", "message": f"未知 API：{path}"})

    def _api_post_content(self) -> None:
        data = self._read_json_body()
        error = validate_content(data)
        if error is not None:
            self._send_json(400, {"ok": False, "error": "INVALID_CONTENT", "message": error})
            return
        self.server.data_store.replace_content(normalize_content(data))
        self._send_json(200, {"ok": True})

    def _api_post_import(self) -> None:
        data = self._read_json_body()
        if not isinstance(data, dict):
            self._send_json(400, {"ok": False, "error": "INVALID_IMPORT", "message": "请求体必须是 JSON 对象"})
            return
        kind = data.get("kind")
        store = self.server.data_store

        if kind == "practice":
            markdown = data.get("markdown")
            if not isinstance(markdown, str) or not markdown.strip():
                self._send_json(400, {"ok": False, "error": "INVALID_IMPORT",
                                      "message": "kind=practice 需要 markdown 字符串"})
                return
            raw_filename = data.get("filename")
            filename = raw_filename.strip() if isinstance(raw_filename, str) and raw_filename.strip() \
                else "未命名练习.md"
            parser_module = load_parser()
            if parser_module is None:
                # parser.py（T1）未就绪或加载失败：返回 400 JSON，绝不崩溃
                self._send_json(400, {"ok": False, "error": "PARSER_UNAVAILABLE",
                                      "message": "parser.py 未就绪或不可用"})
                return
            try:
                result = parser_module.parse(markdown, filename)
            except Exception as exc:  # 解析异常也转为 400
                self._send_json(400, {"ok": False, "error": "PARSE_ERROR", "message": f"解析失败：{exc}"})
                return
            units = result.get("units") if isinstance(result, dict) else None
            if not isinstance(units, list) or not units:
                self._send_json(400, {"ok": False, "error": "PARSE_ERROR", "message": "解析结果中没有单元"})
                return
            for idx, unit in enumerate(units):
                if not isinstance(unit, dict) or not isinstance(unit.get("id"), str) \
                        or not unit["id"].strip():
                    self._send_json(400, {"ok": False, "error": "PARSE_ERROR",
                                          "message": f"解析结果 units[{idx}] 缺少有效 id"})
                    return
            content = store.import_units(units)
            self._send_json(200, {"ok": True, "content": content})

        elif kind == "lecture":
            title = data.get("title")
            markdown = data.get("markdown")
            if not isinstance(title, str) or not title.strip():
                self._send_json(400, {"ok": False, "error": "INVALID_IMPORT",
                                      "message": "kind=lecture 需要 title 字符串"})
                return
            if not isinstance(markdown, str):
                self._send_json(400, {"ok": False, "error": "INVALID_IMPORT",
                                      "message": "kind=lecture 需要 markdown 字符串"})
                return
            content = store.import_lecture_smart(title.strip(), markdown)
            self._send_json(200, {"ok": True, "content": content})

        elif kind == "content":
            content_data = data.get("content")
            error = validate_content(content_data)
            if error is not None:
                self._send_json(400, {"ok": False, "error": "INVALID_CONTENT", "message": error})
                return
            content = store.replace_content(normalize_content(content_data))
            self._send_json(200, {"ok": True, "content": content})

        else:
            self._send_json(400, {"ok": False, "error": "UNKNOWN_KIND", "message": f"未知 kind：{kind!r}"})

    def _api_post_submit(self) -> None:
        data = self._read_json_body()
        if not isinstance(data, dict):
            self._send_json(400, {"ok": False, "error": "INVALID_SUBMISSION", "message": "请求体必须是 JSON 对象"})
            return
        student = data.get("student")
        if not isinstance(student, str) or not student.strip():
            self._send_json(400, {"ok": False, "error": "INVALID_SUBMISSION", "message": "student 不能为空"})
            return
        questions = data.get("questions")
        if not isinstance(questions, list) or not all(isinstance(q, dict) for q in questions):
            self._send_json(400, {"ok": False, "error": "INVALID_SUBMISSION",
                                  "message": "questions 必须是对象数组"})
            return
        record = dict(data)
        record.setdefault("version", 1)
        record["student"] = student
        if not isinstance(record.get("submittedAt"), str) or not record["submittedAt"].strip():
            record["submittedAt"] = utc_now_iso()
        try:
            filename = self.server.data_store.save_submission(record)
        except OSError as exc:
            self._send_json(500, {"ok": False, "error": "SAVE_FAILED", "message": f"落盘失败：{exc}"})
            return
        self._send_json(200, {"ok": True, "file": filename})

    def _api_post_grade(self) -> None:
        data = self._read_json_body()
        if not isinstance(data, dict):
            self._send_json(400, {"ok": False, "error": "INVALID_GRADE", "message": "请求体必须是 JSON 对象"})
            return
        filename = data.get("file")
        if (not isinstance(filename, str) or not filename
                or "/" in filename or "\\" in filename or filename in {".", ".."}):
            self._send_json(400, {"ok": False, "error": "INVALID_GRADE", "message": "file 不合法"})
            return
        question_id = data.get("questionId")
        if not isinstance(question_id, str) or not question_id.strip():
            self._send_json(400, {"ok": False, "error": "INVALID_GRADE", "message": "questionId 不合法"})
            return
        teacher_mark = data.get("teacherMark")
        if teacher_mark not in ("正确", "错误", None):
            self._send_json(400, {"ok": False, "error": "INVALID_GRADE",
                                  "message": "teacherMark 只能是 正确/错误/null"})
            return
        teacher_comment = data.get("teacherComment")
        if teacher_comment is not None and not isinstance(teacher_comment, str):
            self._send_json(400, {"ok": False, "error": "INVALID_GRADE",
                                  "message": "teacherComment 必须是字符串或 null"})
            return
        status = self.server.data_store.grade_submission(filename, question_id,
                                                         teacher_mark, teacher_comment)
        if status == "OK":
            self._send_json(200, {"ok": True})
        elif status == "SUBMISSION_NOT_FOUND":
            self._send_json(404, {"ok": False, "error": "SUBMISSION_NOT_FOUND", "message": "提交文件不存在"})
        elif status == "QUESTION_NOT_FOUND":
            self._send_json(404, {"ok": False, "error": "QUESTION_NOT_FOUND", "message": "提交记录中没有该题目"})
        else:
            self._send_json(500, {"ok": False, "error": "SUBMISSION_CORRUPT", "message": "提交文件损坏，无法批注"})

    # ---------- 其他方法：统一 405 JSON ----------

    def _method_not_allowed(self):
        self._read_body()
        self._send_json(405, {"ok": False, "error": "METHOD_NOT_ALLOWED",
                              "message": "该方法不被支持"}, close=True)

    do_PUT = _method_not_allowed
    do_DELETE = _method_not_allowed
    do_PATCH = _method_not_allowed


# ---------------------------------------------------------------------------
# 服务器与工厂函数
# ---------------------------------------------------------------------------

class QuizHTTPServer(ThreadingHTTPServer):
    """答题系统 HTTP 服务器：携带数据存储与静态目录。"""

    daemon_threads = False        # server_close() 等待在途请求结束，保证测试干净退出
    allow_reuse_address = True

    def __init__(self, address, data_dir, public_dir=None):
        self.data_store = DataStore(data_dir)
        self.public_dir = Path(public_dir) if public_dir is not None else DEFAULT_PUBLIC_DIR
        super().__init__(address, QuizRequestHandler)


def make_server(host, port, data_dir, public_dir=None) -> ThreadingHTTPServer:
    """创建答题系统服务（返回未 serve 的 ThreadingHTTPServer，供测试与 CLI 使用）。

    端口传 0 时由系统分配，实际地址见 server.server_address。
    public_dir 缺省使用项目根下的 public/；可选参数仅供测试注入临时目录。
    """
    return QuizHTTPServer((host, port), data_dir, public_dir=public_dir)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def lan_ipv4_addresses():
    """探测本机局域网 IPv4 地址（不含回环），尽力而为。"""
    addresses = []
    seen = set()

    def add(ip):
        if ip and ip not in seen and not ip.startswith("127."):
            seen.add(ip)
            addresses.append(ip)

    try:  # UDP connect 不发包，仅让系统选路由，最可靠
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("8.8.8.8", 80))
            add(probe.getsockname()[0])
        finally:
            probe.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            add(info[4][0])
    except OSError:
        pass
    return addresses


def main(argv=None) -> int:
    arg_parser = argparse.ArgumentParser(
        prog="server.py",
        description="线上答题系统后端服务（静态文件 + JSON API + 文件存储）",
    )
    arg_parser.add_argument("--host", default="0.0.0.0", help="监听地址（默认 0.0.0.0）")
    arg_parser.add_argument("--port", type=int, default=8787, help="监听端口（默认 8787）")
    arg_parser.add_argument("--data", default="./data", help="数据目录（默认 ./data）")
    args = arg_parser.parse_args(argv)

    try:
        httpd = make_server(args.host, args.port, args.data)
    except OSError as exc:
        print(f"[错误] 服务启动失败：{exc}", file=sys.stderr)
        return 1

    port = httpd.server_address[1]
    bound_host = httpd.server_address[0]
    public_state = "已找到" if DEFAULT_PUBLIC_DIR.is_dir() else "不存在（仅 API 可用）"
    print("=" * 46)
    print("  线上答题系统 服务已启动")
    print(f"  数据目录：{Path(args.data).resolve()}")
    print(f"  静态目录：{DEFAULT_PUBLIC_DIR}（{public_state}）")
    print("  访问地址：")
    print(f"    http://127.0.0.1:{port}/          （本机）")
    if str(bound_host) in ("0.0.0.0", "::"):
        for ip in lan_ipv4_addresses():
            print(f"    http://{ip}:{port}/")
    else:
        print(f"    http://{bound_host}:{port}/       （指定绑定地址）")
    print("  按 Ctrl+C 停止服务")
    print("=" * 46, flush=True)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n正在停止服务…")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
