#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""练习册 MD 解析器（T1）。

把按《有理数打磨/01_线上格式规范.md》第 3 节书写的练习册 Markdown 解析为题库 dict：

    parse(markdown, source="") -> {"version": 1, "source": ..., "units": [...]}

契约来源：docs/01_任务安排与契约.md 第 1 节（content.json schema）与第 4 节（解析规则）。
两者冲突时以契约文件为准。仅使用 Python 标准库。

CLI 用法：
    python parser.py <练习册.md>
解析结果以 UTF-8 JSON 输出到 stdout。
"""

from __future__ import annotations

import json
import re
import sys

__all__ = ["VERSION", "DEFAULT_UNIT_ID", "parse", "parse_file", "main"]

VERSION = 1

# 全文无 H2 但有题目时的兜底单元名
DEFAULT_UNIT_ID = "未命名单元"

# 题型的六个合法取值（不在六值内的题型原样保留，前端按未知类型归入手写题）
QUESTION_TYPES = ("判断", "填空", "选择", "计算", "应用", "找错")

RE_H2 = re.compile(r"^##\s+(.+?)\s*$")
RE_UNIT_COMMENT = re.compile(r"<!--\s*UNIT:\s*(.*?)\s*-->")
RE_QUESTION_HEAD = re.compile(
    r"^#{4}\s*题\s*(\d+)\s*(?:[（(]\s*([^）)]*?)\s*[）)])?.*$"
)
RE_ANSWER = re.compile(r"<!--\s*ANSWER:\s*(.*?)\s*-->")
RE_TYPE_LINE = re.compile(r"^【题型】\s*(.*?)\s*$")
RE_KNOWLEDGE_LINE = re.compile(r"^【考点】\s*(.*?)\s*$")
RE_OPTION_LINE = re.compile(r"^([A-D])[.．、]\s*(.*)$")
RE_SUMMARY = re.compile(r"<summary\b[^>]*>.*?</summary>", re.IGNORECASE | re.DOTALL)
RE_DETAILS_BLOCK = re.compile(
    r"<details\b[^>]*>(.*?)</details\s*>", re.IGNORECASE | re.DOTALL
)
RE_DETAILS_UNCLOSED = re.compile(r"<details\b[^>]*>(.*)$", re.IGNORECASE | re.DOTALL)

# H2 标题开头的编号前缀（无 UNIT 注释时用于从 H2 文本推断 topic，即"H2 去编号标题"）
RE_NUMBERING_PREFIX = re.compile(
    r"^\s*"
    r"(?:"
    r"第\s*[0-9０-９一二三四五六七八九十百千]+\s*讲"
    r"|第\s*[0-9０-９一二三四五六七八九十百千]+\s*[章节课单元]"
    r"|练习\s*[0-9０-９一二三四五六七八九十百千]+"
    r"|\d+(?:\.\d+)*"
    r")"
    r"\s*[-–—.、:：]?\s*"
)


def parse(markdown: str, source: str = "") -> dict:
    """解析练习册 Markdown，返回契约规定的题库 dict（不含 lectures 字段）。"""
    text = _normalize_text(markdown)
    units = []
    for segment in _split_segments(text):
        unit = _build_unit(segment)
        if unit is not None:
            units.append(unit)
    return {"version": VERSION, "source": source, "units": units}


def parse_file(path: str, source: str | None = None) -> dict:
    """从文件读取并解析。utf-8-sig 兼容 BOM；universal newlines 兼容 CRLF。"""
    if source is None:
        source = path
    with open(path, "r", encoding="utf-8-sig") as fh:
        text = fh.read()
    return parse(text, source)


def _normalize_text(markdown: str) -> str:
    """剥离 UTF-8 BOM，统一换行符为 LF。"""
    if markdown.startswith("\ufeff"):
        markdown = markdown[1:]
    return markdown.replace("\r\n", "\n").replace("\r", "\n")


def _split_segments(text: str) -> list:
    """按 H2（`## `）切分为若干段。

    每段形如 {"h2": 标题或 None, "unit_comment": UNIT 注释内容或 None, "lines": [行]}。
    UNIT 注释只在 H2 之后的前 3 行内识别。
    """
    lines = text.split("\n")
    segments = []
    current = {"h2": None, "unit_comment": None, "lines": []}
    for i, line in enumerate(lines):
        m = RE_H2.match(line)
        if m:
            if current["h2"] is not None or current["lines"]:
                segments.append(current)
            current = {"h2": m.group(1).strip(), "unit_comment": None, "lines": []}
            # H2 后前 3 行内找 UNIT 注释
            for j in range(i + 1, min(i + 4, len(lines))):
                mu = RE_UNIT_COMMENT.search(lines[j])
                if mu:
                    current["unit_comment"] = mu.group(1)
                    break
        else:
            current["lines"].append(line)
    segments.append(current)
    return segments


def _strip_numbering(h2_title: str) -> str:
    """去掉 H2 标题开头的编号（第 X 讲 / 第 X 章 / 练习X / 纯数字编号），得 topic。"""
    stripped = RE_NUMBERING_PREFIX.sub("", h2_title, count=1).strip()
    return stripped if stripped else h2_title


def _build_unit(segment: dict) -> dict | None:
    """把一段构建成单元 dict；段内没有题目时返回 None（空单元不入库）。"""
    questions = _parse_questions(segment["lines"])
    if not questions:
        return None
    h2_title = segment["h2"]
    if h2_title is None:
        unit_id = DEFAULT_UNIT_ID
        lecture = ""
        topic = ""
    else:
        comment = segment["unit_comment"]
        if comment:
            parts = [p.strip() for p in comment.split("|")]
            unit_id = parts[0] if parts and parts[0] else h2_title
            lecture = parts[1] if len(parts) > 1 else ""
            topic = parts[2] if len(parts) > 2 else ""
        else:
            # 无 UNIT 注释：从 H2 文本推断
            unit_id = h2_title
            lecture = ""
            topic = _strip_numbering(h2_title)

    # id = {单元id}-{number}，单元内重复题号追加 -2、-3 … 后缀保证唯一
    seen = {}
    for q in questions:
        n = q["number"]
        seen[n] = seen.get(n, 0) + 1
        base = "{}-{}".format(unit_id, n)
        q["id"] = base if seen[n] == 1 else "{}-{}".format(base, seen[n])

    return {
        "id": unit_id,
        "unit": unit_id,
        "lecture": lecture,
        "topic": topic,
        "questions": questions,
    }


def _parse_questions(lines: list) -> list:
    """扫描段内各行，切出题目并抽取字段。"""
    questions = []
    i = 0
    total = len(lines)
    while i < total:
        m = RE_QUESTION_HEAD.match(lines[i])
        if not m:
            i += 1
            continue
        number = int(m.group(1))
        difficulty = (m.group(2) or "").count("★")
        i += 1

        q_type = ""
        knowledge = ""
        stem_lines = []
        answer_text = None
        tail_lines = []
        while i < total:
            line = lines[i]
            if RE_QUESTION_HEAD.match(line) or RE_H2.match(line):
                break  # 下一题 / 下一单元开始
            if answer_text is None:
                mt = RE_TYPE_LINE.match(line)
                if mt and not q_type:
                    q_type = mt.group(1).strip()
                    i += 1
                    continue
                mk = RE_KNOWLEDGE_LINE.match(line)
                if mk and not knowledge:
                    knowledge = mk.group(1).strip()
                    i += 1
                    continue
                ma = RE_ANSWER.search(line)
                if ma:
                    answer_text = ma.group(1)
                    i += 1
                    continue
                stem_lines.append(line)
                i += 1
            else:
                tail_lines.append(line)
                i += 1

        # 选项抽取：以 A.~D. 开头的行抽为 options，其余拼回 stem
        options = []
        stem_parts = []
        for line in stem_lines:
            mo = RE_OPTION_LINE.match(line)
            if mo:
                options.append({"key": mo.group(1), "text": mo.group(2).strip()})
            else:
                stem_parts.append(line)
        stem = "\n".join(stem_parts).strip()

        # 答案按 ;; 拆分并 trim
        if answer_text is not None and answer_text.strip():
            answers = [p.strip() for p in answer_text.split(";;")]
            if answers == [""]:
                answers = []
        else:
            answers = []

        questions.append(
            {
                "id": "",  # 占位，_build_unit 中回填
                "number": number,
                "difficulty": difficulty,
                "type": q_type,
                "knowledge": knowledge,
                "stem": stem,
                "options": options,
                "answers": answers,
                "solutionMd": _extract_solution(tail_lines),
            }
        )
    return questions


def _extract_solution(tail_lines: list) -> str:
    """从 ANSWER 之后的文本中提取 <details>…</details> 详解。

    剔除 <summary>…</summary>，去掉首尾空行；无详解返回空串。
    输入含 emoji/HTML 一律原样保留，不做清洗。
    """
    text = "\n".join(tail_lines)
    m = RE_DETAILS_BLOCK.search(text)
    if m is None:
        m = RE_DETAILS_UNCLOSED.search(text)  # 容忍缺失 </details>
        if m is None:
            return ""
    inner = RE_SUMMARY.sub("", m.group(1))
    rows = [row.rstrip() for row in inner.split("\n")]
    while rows and not rows[0].strip():
        rows.pop(0)
    while rows and not rows[-1].strip():
        rows.pop()
    return "\n".join(rows).strip()


def main(argv: list | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 1:
        print("用法: python parser.py <练习册.md>", file=sys.stderr)
        return 2
    path = argv[0]
    try:
        result = parse_file(path)
    except FileNotFoundError:
        print("文件不存在: {}".format(path), file=sys.stderr)
        return 1
    except UnicodeDecodeError as exc:
        print("文件不是有效的 UTF-8 编码: {}".format(exc), file=sys.stderr)
        return 1
    except OSError as exc:
        print("读取失败: {}".format(exc), file=sys.stderr)
        return 1

    # 防 Windows 控制台 GBK 编码报错
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
