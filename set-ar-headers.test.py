"""Privacy regression tests for the embedded header-update program.

Only the Python payload is executed; no Docker or ownership commands run.
"""
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


class HeaderOutputPrivacyTests(unittest.TestCase):
    def run_update(self, headers):
        script = Path(__file__).with_name("set-ar-headers.sh").read_text(encoding="utf-8")
        payload = script.split("python3 -c '\n", 1)[1].split("\n' ", 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            auth = Path(directory) / "plugin-auth.json"
            auth.write_text(json.dumps({"agentrouter": {
                "type": "api", "key": "synthetic-existing-key",
                "metadata": {"headers": "old-synthetic-header", "untouched": "keep"},
            }}), encoding="utf-8")
            stdout, stderr = io.StringIO(), io.StringIO()
            with patch.object(sys, "argv", ["header-helper", headers, str(auth)]):
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    exec(compile(payload, "<header-helper>", "exec"), {})
            return json.loads(auth.read_text(encoding="utf-8")), stdout.getvalue(), stderr.getvalue()

    def test_setting_headers_does_not_log_sensitive_values(self):
        values = ["synthetic-token", "synthetic-cookie", "synthetic-api-secret", "synthetic-private-context"]
        headers = "\n".join([
            "Authorization: Bearer " + values[0], "Cookie: session=" + values[1],
            "X-API-Key: " + values[2], "X-Trace-Context: " + values[3],
        ])
        auth, stdout, stderr = self.run_update(headers)
        self.assertEqual(auth["agentrouter"]["metadata"]["headers"], headers)
        self.assertEqual(auth["agentrouter"]["metadata"]["untouched"], "keep")
        self.assertEqual(auth["agentrouter"]["key"], "synthetic-existing-key")
        self.assertTrue(stdout.strip())
        for value in values + ["synthetic-existing-key", "old-synthetic-header"]:
            self.assertNotIn(value, stdout + stderr)
        self.assertEqual(stderr, "")

    def test_clearing_headers_does_not_log_existing_auth(self):
        auth, stdout, stderr = self.run_update("")
        self.assertNotIn("headers", auth["agentrouter"]["metadata"])
        self.assertEqual(auth["agentrouter"]["key"], "synthetic-existing-key")
        self.assertEqual(auth["agentrouter"]["metadata"]["untouched"], "keep")
        self.assertTrue(stdout.strip())
        self.assertEqual(stderr, "")
        for value in ["old-synthetic-header", "synthetic-existing-key"]:
            self.assertNotIn(value, stdout + stderr)


if __name__ == "__main__":
    unittest.main()
