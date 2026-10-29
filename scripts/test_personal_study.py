import importlib.util
import pathlib
import tempfile
import unittest
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

spec = importlib.util.spec_from_file_location("personal", pathlib.Path(__file__).with_name("personal-study.py"))
personal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(personal)


class Tests(unittest.TestCase):
    def test_unique(self):
        row = {"id": "one"}
        self.assertEqual(personal.select_student([row]), row)

    def test_ambiguous(self):
        for rows in ([], [{"id": "a"}, {"id": "b"}], [{"id": "a", "archived": True}]):
            with self.assertRaises(ValueError):
                personal.select_student(rows)

    def test_explicit(self):
        self.assertEqual(personal.select_student([{"id": "a"}, {"id": "b"}], "b")["id"], "b")

    def test_origin(self):
        for url in ("file:///tmp/x", "https://u:p@example.com", "http://localhost/path", "http://localhost/?x=1"):
            with self.assertRaises(ValueError):
                personal.Client(url)

    def test_preview_commit(self):
        class Fake:
            def __init__(self):
                self.calls = []
            def call(self, path, body):
                self.calls.append((path, body))
                return {"summary": {}}
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "lesson.md"
            path.write_text("# Lesson", encoding="utf-8")
            fake = Fake()
            personal.import_document(fake, path)
            self.assertEqual(len(fake.calls), 1)
            personal.import_document(fake, path, True)
            self.assertEqual([p for p, _ in fake.calls][-2:],
                             ["/api/teacher/import/preview", "/api/teacher/import/commit"])

    def test_publish(self):
        class Fake:
            def __init__(self):
                self.calls = []
            def call(self, path, body):
                self.calls.append((path, dict(body)))
                return {"summary": {}}
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "lesson.md"
            path.write_text("# Lesson", encoding="utf-8")
            fake = Fake()
            personal.import_document(fake, path, True, "course", "self")
            self.assertEqual(fake.calls[1][1]["addToCourse"],
                             {"courseId": "course", "visible": True})
            self.assertEqual(fake.calls[2], ("/api/teacher/courses/course/members",
                                            {"studentIds": ["self"]}))
            with self.assertRaises(ValueError):
                personal.import_document(fake, path, False, "course", "self")

    def test_commit_failure_stops_membership(self):
        class Fake:
            def __init__(self):
                self.paths = []
            def call(self, path, body):
                self.paths.append(path)
                if path.endswith("/commit"):
                    raise RuntimeError("rejected")
                return {}
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "lesson.md"
            path.write_text("# Lesson", encoding="utf-8")
            fake = Fake()
            with self.assertRaises(RuntimeError):
                personal.import_document(fake, path, True, "course", "self")
            self.assertEqual(len(fake.paths), 2)

    def test_real_http_cookie_and_redirect(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self.send_response(200)
                self.send_header("Set-Cookie", "local_session=test-only; Path=/")
                self.end_headers()
                self.wfile.write(b'{"ok":true,"data":{}}')
            def do_GET(self):
                if self.path == "/redirect":
                    self.send_response(302)
                    self.send_header("Location", "/must-not-follow")
                    self.end_headers()
                    return
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"ok":true,"data":{"cookie":true}}' if
                    self.headers.get("Cookie") == "local_session=test-only" else
                    b'{"ok":false}')
        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = personal.Client("http://127.0.0.1:" + str(server.server_port))
            client.call("/login", {})
            self.assertTrue(client.call("/protected")["cookie"])
            with self.assertRaises(RuntimeError):
                client.call("/redirect")
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

    def test_large(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "big.md"
            path.write_bytes(b"x" * (1024 * 1024 + 1))
            with self.assertRaises(ValueError):
                personal.import_document(None, path)


if __name__ == "__main__":
    unittest.main()
