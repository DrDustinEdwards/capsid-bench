import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from repro import split_diff, verdict  # noqa: E402

NEW = "diff --git a/tests/test_issue.py b/tests/test_issue.py\nnew file mode 100644\n--- /dev/null\n+++ b/tests/test_issue.py\n@@ -0,0 +1 @@\n+def test_x(): assert f() == 2\n"
FIX = "diff --git a/src/f.py b/src/f.py\n--- a/src/f.py\n+++ b/src/f.py\n@@ -1 +1 @@\n-def f(): return 1\n+def f(): return 2\n"


class SplitDiff(unittest.TestCase):
    def test_takes_out_only_the_named_new_file(self):
        self.assertEqual(split_diff(FIX + NEW, "tests/test_issue.py"), (NEW, FIX))

    def test_refuses_a_file_that_already_existed(self):
        edited = NEW.replace("new file mode 100644\n", "")
        self.assertEqual(split_diff(FIX + edited, "tests/test_issue.py")[0], None)


class Verdict(unittest.TestCase):
    T = "tests/test_issue.py::test_x"

    def test_failed_on_the_base_and_passed_on_the_diff(self):
        self.assertTrue(verdict({self.T: "FAILED"}, "", {self.T: "PASSED"})[0])

    def test_an_error_or_an_import_failure_on_the_base_is_not_a_reproduction(self):
        self.assertFalse(verdict({self.T: "ERROR"}, "", {self.T: "PASSED"})[0])
        log = f"FAILED {self.T} - ImportError: cannot import name 'g'"
        self.assertFalse(verdict({self.T: "FAILED"}, log, {self.T: "PASSED"})[0])

    def test_a_test_still_failing_on_the_diff_is_refused(self):
        self.assertFalse(verdict({self.T: "FAILED"}, "", {self.T: "FAILED"})[0])


if __name__ == "__main__":
    unittest.main()
