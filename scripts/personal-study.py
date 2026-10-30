#!/usr/bin/env python3
"""Personal learning CLI; stdlib only, no credential files or authentication bypass."""
import argparse
import getpass
import http.cookiejar
import json
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request


class Client:
    def __init__(self, base):
        url = urllib.parse.urlsplit(base)
        if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
            raise ValueError("base must be an HTTP(S) origin without credentials")
        # Credentials are sent only to this origin; never follow redirects.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None
        self.base = base.rstrip("/")
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
            NoRedirect(),
        )

    def call(self, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data,
                                     headers={"Content-Type": "application/json"})
        try:
            with self.opener.open(req, timeout=30) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            # Do not echo bodies: login responses can contain credentials.
            raise RuntimeError(f"HTTP {error.code} at {path}") from None
        if result.get("ok") is not True:
            raise RuntimeError("API request failed")
        return result["data"]


def select_student(rows, student_id=None):
    active = [s for s in rows if not s.get("archived", False)]
    matches = active if student_id is None else [s for s in active if s["id"] == student_id]
    if len(matches) != 1:
        raise ValueError("Specify --student-id: active learner is missing or ambiguous")
    return matches[0]


def import_document(client, path, commit=False, course_id=None, student_id=None):
    path = pathlib.Path(path)
    if path.stat().st_size > 1024 * 1024:
        raise ValueError("Markdown exceeds the existing 1 MiB import limit")
    body = {"filename": path.name, "markdown": path.read_text(encoding="utf-8")}
    if course_id and not commit:
        raise ValueError("Publishing requires --commit")
    if course_id and not student_id:
        raise ValueError("Publishing requires a selected learner")
    preview = client.call("/api/teacher/import/preview", body)
    if commit:
        # Server revalidates lint and ownership inside its normal transaction.
        if course_id:
            body["addToCourse"] = {"courseId": course_id, "visible": True}
        client.call("/api/teacher/import/commit", body)
        if course_id:
            # Existing server enforces course and learner ownership.
            # Not atomic across endpoints: failures must not be reported as success.
            client.call("/api/teacher/courses/" + urllib.parse.quote(course_id, safe="") + "/members",
                        {"studentIds": [student_id]})
    return preview


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:8787")
    parser.add_argument("--login-name", required=True)
    parser.add_argument("--setup", action="store_true", help="Explicit first-run account creation")
    parser.add_argument("--create-self", action="store_true", help="Create one learner only when none exists")
    parser.add_argument("--student-id")
    parser.add_argument("--markdown")
    parser.add_argument("--publish-course-id", help="Publish into an existing course; ALL existing members can see it")
    parser.add_argument("--commit", action="store_true", help="Actually import; default is preview only")
    args = parser.parse_args(argv)
    if args.commit and not args.markdown:
        parser.error("--commit requires --markdown")
    if args.publish_course_id and not (args.commit and args.markdown):
        parser.error("--publish-course-id requires --markdown and --commit")
    client = Client(args.base)
    password = getpass.getpass("Local owner password (not saved): ")
    endpoint = "setup" if args.setup else "login"
    client.call("/api/public/teacher/" + endpoint,
                {"loginName": args.login_name, "password": password})
    del password
    rows = client.call("/api/teacher/students")["students"]
    if not rows and args.create_self:
        if args.student_id:
            raise ValueError("Cannot create a learner when --student-id is specified")
        student = client.call("/api/teacher/students",
                              {"displayName": "我", "loginName": args.login_name[:27] + "_self"})["student"]
    else:
        student = select_student(rows, args.student_id)
    if not student.get("linkEnabled", False):
        raise ValueError("Learner link login is disabled; enable it explicitly in settings")
    if args.markdown:
        preview = import_document(client, args.markdown, args.commit, args.publish_course_id, student["id"])
        # Only safe summary fields: never dump source/answers/tokens.
        print(json.dumps({"phase": "committed" if args.commit else "preview",
                          "summary": preview.get("summary", {})}, ensure_ascii=False))
    print("Learner ready. Use existing lecture-qr.mjs with the selected learner id locally.")
    print("Learner id:", student["id"])
    print("No credentials or QR links were saved.")
    print("Published to the existing course." if args.publish_course_id else
          "Import alone does not publish; use --publish-course-id with --commit.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, RuntimeError, OSError, urllib.error.URLError):
        print("Personal study operation failed; check server, account and arguments. No response body logged.",
              file=sys.stderr)
        raise SystemExit(1)
