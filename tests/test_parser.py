# -*- coding: utf-8 -*-
"""T1 parser.py 单元测试。

覆盖契约 docs/01_任务安排与契约.md 第 4 节列出的全部测试点：
单元切分与 UNIT 注释、六种题型各一、多空 ;; 答案、选择题选项抽取、
难度星解析、详解提取与 summary 剔除、无 UNIT 回退、CRLF+BOM 输入、
重复题号 id 去重后缀。测试数据全部内嵌字符串，不依赖 samples/ 目录。
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

# 把项目根目录加入 sys.path，以便 import parser
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import parser  # noqa: E402

# 所有含反斜杠（LaTeX \times 等）的夹具一律用 raw 字符串，防止被转义

TWO_UNITS_MD = r"""# 七年级有理数配套练习

## 练习四 有理数加法

<!-- UNIT: 练习四|第4讲|有理数加法 -->

#### 题 1（★★）
【题型】计算
【考点】有理数加法
计算：$(-2)+5=$ ____。

<!-- ANSWER: 3 -->

<details>
<summary>查看详解</summary>

【思路】异号两数相加，取绝对值较大的加数的符号。

【过程】$(-2)+5=+(5-2)=3$。

【易错】不要直接把 $2$ 与 $5$ 相加。

</details>

#### 题 2（★）
【题型】判断
【考点】加法法则
判断：两个负数相加，和一定为负数。

<!-- ANSWER: 正确 -->

<details>
<summary>查看详解</summary>

【思路】同号两数相加，取相同的符号。

【过程】两个负数相加，和的符号与加数相同，仍为负数。

【易错】不要误以为两个负数相加可能得正数。

</details>

## 练习五 有理数减法

<!-- UNIT: 练习五|第4讲|有理数减法 -->

#### 题 1（★）
【题型】填空
【考点】有理数减法
填空：$4-9=$ ____。

<!-- ANSWER: -5 -->

<details>
<summary>查看详解</summary>

【思路】减去一个数等于加上它的相反数。

【过程】$4-9=4+(-9)=-5$。

【易错】结果不要丢掉负号。

</details>
"""

SIX_TYPES_MD = r"""## 单元甲

<!-- UNIT: 单元甲|第1讲|混合 -->

#### 题 1（★）
【题型】判断
【考点】相反数
判断：$-3$ 的相反数是 $3$。

<!-- ANSWER: 正确 -->

<details>
<summary>查看详解</summary>

【思路】相反数符号相反。

【过程】$-(-3)=3$。

【易错】不要与绝对值混淆。

</details>

#### 题 2（★）
【题型】填空
【考点】有理数加法
填空：$(-1)+2=$ ____。

<!-- ANSWER: 1 -->

<details>
<summary>查看详解</summary>

【过程】$(-1)+2=+(2-1)=1$。

</details>

#### 题 3（★★）
【题型】选择
【考点】有理数减法
计算 $0-(-2)$ 的结果是（　）。
A. $-2$
B. $2$
C. $0$
D. $4$

<!-- ANSWER: B -->

<details>
<summary>查看详解</summary>

【过程】$0-(-2)=0+2=2$，所以选 B。

</details>

#### 题 4（★★）
【题型】计算
【考点】加减混合
计算：$1-2+3$。

<!-- ANSWER: 2 -->

<details>
<summary>查看详解</summary>

【过程】$1-2+3=(-1)+3=2$。

</details>

#### 题 5（★★★）
【题型】应用
【考点】温差
某地气温从 $-2$ ℃上升 $5$ ℃，求此时气温。

<!-- ANSWER: 3 -->

<details>
<summary>查看详解</summary>

【过程】$-2+5=3$，此时气温是 $3$ ℃。

</details>

#### 题 6（★）
【题型】找错
【考点】减法法则
找出错误并改正：$2-(-6)=2-6=-4$。

<!-- ANSWER: 错在未把减法转化为加法，应为 $2-(-6)=2+6=8$ -->

<details>
<summary>查看详解</summary>

【过程】$2-(-6)=2+6=8$。

</details>
"""

MULTI_BLANK_MD = r"""## 多空单元

<!-- UNIT: 多空单元|第2讲|相反数与绝对值 -->

#### 题 1（★★）
【题型】填空
【考点】相反数与绝对值
填空：$2$ 的相反数是 ____；$|-3|=$ ____。

<!-- ANSWER: -2;; 3 -->
"""

DIFFICULTY_MD = r"""## 难度单元

<!-- UNIT: 难度单元|第1讲|难度星 -->

#### 题 1（★）
【题型】判断
【考点】难度一
略。

<!-- ANSWER: 正确 -->

#### 题 2（★★）
【题型】判断
【考点】难度二
略。

<!-- ANSWER: 正确 -->

#### 题 3（★★★）
【题型】判断
【考点】难度三
略。

<!-- ANSWER: 正确 -->

#### 题 4
【题型】判断
【考点】无难度
略。

<!-- ANSWER: 正确 -->
"""

NO_UNIT_MD = r"""## 练习六 有理数乘法

#### 题 1（★）
【题型】填空
【考点】有理数乘法
填空：$(-2)\times3=$ ____。

<!-- ANSWER: -6 -->
"""

UNIT_AT_THIRD_LINE_MD = r"""## 单元丙


<!-- UNIT: 单元丙|第2讲|三行内 -->

#### 题 1（★）
【题型】判断
【考点】三行内
略。

<!-- ANSWER: 正确 -->
"""

UNIT_AT_FOURTH_LINE_MD = r"""## 单元丁



<!-- UNIT: 单元丁|第2讲|超出三行 -->

#### 题 1（★）
【题型】判断
【考点】超出三行
略。

<!-- ANSWER: 正确 -->
"""

NO_H2_MD = r"""# 随手练

#### 题 1（★）
【题型】判断
【考点】自然数
判断：$0$ 是最小的自然数。

<!-- ANSWER: 正确 -->
"""

DUP_MD = r"""## 重复单元

<!-- UNIT: 重复单元|第1讲|去重 -->

#### 题 1（★）
【题型】判断
【考点】第一题
略。

<!-- ANSWER: 正确 -->

#### 题 2（★）
【题型】判断
【考点】第二题
略。

<!-- ANSWER: 正确 -->

#### 题 2（★）
【题型】判断
【考点】第二题重复
略。

<!-- ANSWER: 正确 -->

#### 题 2（★）
【题型】判断
【考点】第二题再重复
略。

<!-- ANSWER: 正确 -->
"""

ODD_MD = r"""## 单元戊

<!-- UNIT: 单元戊|第3讲|杂项 -->

#### 题 1
【题型】Choice
【考点】未知题型
判断：这是 🎉 一段 <b>HTML</b> 与 emoji 混排的题干 ____。

<!-- ANSWER: 保持原样 -->
"""

BLANK_LINES_MD = r"""## 空行单元

<!-- UNIT: 空行单元|第1讲|容忍空行 -->

#### 题 1（★）
【题型】填空
【考点】空行容忍

计算：$1+1=$ ____。


<!-- ANSWER: 2 -->

<details>
<summary>查看详解</summary>

【过程】$1+1=2$。

</details>
"""


def parse_first(md, source="测试"):
    """解析并返回（全文 dict, 第一个单元, 第一个单元的第一题）。"""
    data = parser.parse(md, source)
    unit = data["units"][0]
    return data, unit, unit["questions"][0]


class TestUnitSplitting(unittest.TestCase):
    """单元切分与 UNIT 注释。"""

    def test_two_units_with_unit_comments(self):
        data = parser.parse(TWO_UNITS_MD, "有理数配套练习.md")
        self.assertEqual(data["version"], 1)
        self.assertEqual(data["source"], "有理数配套练习.md")
        self.assertEqual(len(data["units"]), 2)
        u1, u2 = data["units"]
        self.assertEqual((u1["id"], u1["unit"]), ("练习四", "练习四"))
        self.assertEqual((u1["lecture"], u1["topic"]), ("第4讲", "有理数加法"))
        self.assertEqual((u2["id"], u2["lecture"], u2["topic"]),
                         ("练习五", "第4讲", "有理数减法"))
        self.assertEqual([len(u["questions"]) for u in data["units"]], [2, 1])
        # 题目 id = {单元id}-{number}
        self.assertEqual(
            [q["id"] for q in u1["questions"]], ["练习四-1", "练习四-2"])

    def test_unit_comment_only_recognized_within_three_lines(self):
        # UNIT 注释在 H2 后第 3 行：生效
        _, unit, _ = parse_first(UNIT_AT_THIRD_LINE_MD)
        self.assertEqual(unit["id"], "单元丙")
        self.assertEqual((unit["lecture"], unit["topic"]), ("第2讲", "三行内"))
        # UNIT 注释在 H2 后第 4 行：不识别，回退为从 H2 推断
        _, unit, _ = parse_first(UNIT_AT_FOURTH_LINE_MD)
        self.assertEqual(unit["id"], "单元丁")
        self.assertEqual(unit["lecture"], "")
        self.assertEqual(unit["topic"], "单元丁")

    def test_h2_without_unit_comment_fallback(self):
        data, unit, q = parse_first(NO_UNIT_MD)
        self.assertEqual(unit["id"], "练习六 有理数乘法")
        self.assertEqual(unit["unit"], "练习六 有理数乘法")
        self.assertEqual(unit["lecture"], "")
        self.assertEqual(unit["topic"], "有理数乘法")  # H2 去编号标题
        self.assertEqual(q["id"], "练习六 有理数乘法-1")
        self.assertEqual(q["answers"], ["-6"])

    def test_no_h2_questions_go_to_unnamed_unit(self):
        _, unit, q = parse_first(NO_H2_MD)
        self.assertEqual(unit["id"], "未命名单元")
        self.assertEqual(unit["unit"], "未命名单元")
        self.assertEqual(unit["lecture"], "")
        self.assertEqual(unit["topic"], "")
        self.assertEqual(q["id"], "未命名单元-1")

    def test_unit_without_questions_is_skipped(self):
        data = parser.parse("## 说明\n\n本单元没有题目。\n")
        self.assertEqual(data["units"], [])


class TestQuestionFields(unittest.TestCase):
    """题型、难度、答案、选项。"""

    def test_six_question_types(self):
        data = parser.parse(SIX_TYPES_MD)
        questions = data["units"][0]["questions"]
        self.assertEqual([q["type"] for q in questions],
                         ["判断", "填空", "选择", "计算", "应用", "找错"])
        self.assertEqual([q["number"] for q in questions], [1, 2, 3, 4, 5, 6])
        self.assertEqual([q["id"] for q in questions],
                         ["单元甲-%d" % n for n in range(1, 7)])

    def test_unknown_type_kept_as_is(self):
        # 题型不在六值内：原样保留，不转小写
        _, _, q = parse_first(ODD_MD)
        self.assertEqual(q["type"], "Choice")

    def test_difficulty_stars(self):
        questions = parser.parse(DIFFICULTY_MD)["units"][0]["questions"]
        self.assertEqual([q["difficulty"] for q in questions], [1, 2, 3, 0])

    def test_multi_blank_answers_split_by_semicolons(self):
        _, _, q = parse_first(MULTI_BLANK_MD)
        self.assertEqual(q["answers"], ["-2", "3"])

    def test_answer_is_trimmed(self):
        md = MULTI_BLANK_MD.replace("<!-- ANSWER: -2;; 3 -->",
                                    "<!-- ANSWER:   -2 ;;   3  -->")
        _, _, q = parse_first(md)
        self.assertEqual(q["answers"], ["-2", "3"])

    def test_missing_answer_yields_empty_list(self):
        md = "## 空答案单元\n\n#### 题 1（★）\n【题型】填空\n【考点】缺答案\n填空：$1+1=$ ____。\n"
        _, _, q = parse_first(md)
        self.assertEqual(q["answers"], [])

    def test_choice_options_extraction(self):
        questions = parser.parse(SIX_TYPES_MD)["units"][0]["questions"]
        choice = questions[2]
        self.assertEqual(choice["options"], [
            {"key": "A", "text": "$-2$"},
            {"key": "B", "text": "$2$"},
            {"key": "C", "text": "$0$"},
            {"key": "D", "text": "$4$"},
        ])
        # 选项行不残留在题干中
        self.assertEqual(choice["stem"], "计算 $0-(-2)$ 的结果是（　）。")
        # 非选择题 options 为空数组
        self.assertEqual(questions[0]["options"], [])
        self.assertEqual(questions[3]["options"], [])

    def test_blank_lines_inside_question_tolerated(self):
        _, _, q = parse_first(BLANK_LINES_MD)
        self.assertEqual(q["stem"], "计算：$1+1=$ ____。")
        self.assertEqual(q["answers"], ["2"])
        self.assertEqual(q["solutionMd"], "【过程】$1+1=2$。")

    def test_emoji_and_html_preserved(self):
        _, _, q = parse_first(ODD_MD)
        self.assertEqual(
            q["stem"], "判断：这是 🎉 一段 <b>HTML</b> 与 emoji 混排的题干 ____。")
        self.assertEqual(q["answers"], ["保持原样"])
        self.assertEqual(q["difficulty"], 0)  # 题号行无难度括号

    def test_type_and_knowledge_fields(self):
        questions = parser.parse(SIX_TYPES_MD)["units"][0]["questions"]
        self.assertEqual(questions[0]["knowledge"], "相反数")
        self.assertEqual(questions[2]["knowledge"], "有理数减法")


class TestSolution(unittest.TestCase):
    """详解提取与 summary 剔除。"""

    def test_solution_extracted_and_summary_removed(self):
        _, _, q = parse_first(TWO_UNITS_MD)
        self.assertEqual(
            q["solutionMd"],
            "【思路】异号两数相加，取绝对值较大的加数的符号。\n\n"
            "【过程】$(-2)+5=+(5-2)=3$。\n\n"
            "【易错】不要直接把 $2$ 与 $5$ 相加。")
        self.assertNotIn("<details", q["solutionMd"])
        self.assertNotIn("</details", q["solutionMd"])
        self.assertNotIn("<summary", q["solutionMd"])
        self.assertNotIn("查看详解", q["solutionMd"])

    def test_no_details_yields_empty_solution(self):
        _, _, q = parse_first(MULTI_BLANK_MD)
        self.assertEqual(q["solutionMd"], "")


class TestDuplicateIds(unittest.TestCase):
    """重复题号 id 去重后缀。"""

    def test_duplicate_number_gets_suffix(self):
        unit = parser.parse(DUP_MD)["units"][0]
        self.assertEqual([q["id"] for q in unit["questions"]],
                         ["重复单元-1", "重复单元-2", "重复单元-2-2", "重复单元-2-3"])
        # number 字段保留原始题号
        self.assertEqual([q["number"] for q in unit["questions"]], [1, 2, 2, 2])


class TestEncodingCompat(unittest.TestCase):
    """CRLF 与 UTF-8 BOM 兼容。"""

    def test_crlf_and_bom_in_string(self):
        text = "\ufeff" + TWO_UNITS_MD.replace("\n", "\r\n")
        data = parser.parse(text, "crlf")
        self.assertEqual([u["id"] for u in data["units"]], ["练习四", "练习五"])
        self.assertEqual(len(data["units"][0]["questions"]), 2)
        self.assertEqual(data["units"][0]["questions"][0]["answers"], ["3"])
        self.assertIn("【过程】", data["units"][0]["questions"][0]["solutionMd"])

    def test_crlf_and_bom_file_binary_write(self):
        # Windows 上写临时文件必须用二进制模式，避免 \n 被自动翻译回 \r\n
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "crlf_bom.md")
            raw = "\ufeff" + SIX_TYPES_MD.replace("\n", "\r\n")
            with open(path, "wb") as fh:
                fh.write(raw.encode("utf-8"))
            data = parser.parse_file(path, "crlf文件")
        self.assertEqual(data["source"], "crlf文件")
        questions = data["units"][0]["questions"]
        self.assertEqual(len(questions), 6)
        self.assertEqual(questions[2]["options"][1],
                         {"key": "B", "text": "$2$"})
        self.assertEqual(questions[0]["solutionMd"],
                         "【思路】相反数符号相反。\n\n【过程】$-(-3)=3$。"
                         "\n\n【易错】不要与绝对值混淆。")


class TestParseApiShape(unittest.TestCase):
    """返回值结构与 schema 一致。"""

    def test_top_level_shape(self):
        data = parser.parse(SIX_TYPES_MD, "示例.md")
        self.assertEqual(list(data.keys()), ["version", "source", "units"])
        self.assertNotIn("lectures", data)
        self.assertEqual(data["version"], 1)
        self.assertEqual(data["source"], "示例.md")

    def test_unit_and_question_keys_match_schema(self):
        unit = parser.parse(TWO_UNITS_MD)["units"][0]
        self.assertEqual(list(unit.keys()),
                         ["id", "unit", "lecture", "topic", "questions"])
        q = unit["questions"][0]
        self.assertEqual(
            list(q.keys()),
            ["id", "number", "difficulty", "type", "knowledge", "stem",
             "options", "answers", "solutionMd"])

    def test_empty_markdown(self):
        data = parser.parse("")
        self.assertEqual(data, {"version": 1, "source": "", "units": []})


class TestCli(unittest.TestCase):
    """命令行入口。"""

    def test_cli_outputs_utf8_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            md_path = os.path.join(tmp, "cli练习.md")
            with open(md_path, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(SIX_TYPES_MD)
            proc = subprocess.run(
                [sys.executable, os.path.join(ROOT, "parser.py"), md_path],
                capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        data = json.loads(proc.stdout)  # stdout 必须是合法 JSON
        self.assertEqual(data["version"], 1)
        self.assertEqual(len(data["units"]), 1)
        self.assertEqual(len(data["units"][0]["questions"]), 6)
        # 中文未转义为 \uXXXX（ensure_ascii=False）
        self.assertIn("单元甲", proc.stdout)

    def test_cli_missing_file_returns_nonzero(self):
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, "parser.py"),
             os.path.join("不存在的目录", "没有.md")],
            capture_output=True, text=True, encoding="utf-8")
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), "")


if __name__ == "__main__":
    unittest.main()
