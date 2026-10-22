"""The validation verdict (scripts/validate.py), against hand-made status maps: the gate
order, the two test lists, and that three runs must agree."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from validate import verdict  # noqa: E402

PASSED = {"PASSED", "XFAIL"}
passed = lambda t, sm: t in sm and sm[t] in PASSED
failed = lambda t, sm: t not in sm or sm[t] in {"FAILED", "ERROR"}

BEFORE = {"t::new": "FAILED", "t::old": "PASSED", "t::broken": "FAILED"}
AFTER = {"t::new": "PASSED", "t::old": "PASSED", "t::broken": "FAILED"}


class Verdict(unittest.TestCase):
    def test_passes_with_both_lists(self):
        self.assertEqual(verdict([BEFORE] * 3, [AFTER] * 3, passed, failed), {"verdict": "passed", "FAIL_TO_PASS": ["t::new"], "PASS_TO_PASS": ["t::old"]})

    def test_did_not_fail_before(self):
        green = {"t::new": "PASSED", "t::old": "PASSED"}
        self.assertEqual(verdict([green] * 3, [green] * 3, passed, failed)["verdict"], "did not fail before")

    def test_did_not_pass_after(self):
        self.assertEqual(verdict([BEFORE] * 3, [BEFORE] * 3, passed, failed)["verdict"], "did not pass after")

    def test_reruns_disagree(self):
        flaky = dict(AFTER, **{"t::old": "FAILED"})
        self.assertEqual(verdict([BEFORE] * 3, [AFTER, AFTER, flaky], passed, failed)["verdict"], "reruns disagreed")
        self.assertEqual(verdict([BEFORE, BEFORE, None], [AFTER] * 3, passed, failed)["verdict"], "reruns disagreed")
        self.assertEqual(verdict([BEFORE] * 3, [AFTER, None, AFTER], passed, failed)["verdict"], "reruns disagreed")
        # A first pair with nothing that turns green still reports the disagreement.
        green = {"t::new": "PASSED", "t::old": "PASSED"}
        self.assertEqual(verdict([green, BEFORE, BEFORE], [green, AFTER, AFTER], passed, failed)["verdict"], "reruns disagreed")


if __name__ == "__main__":
    unittest.main()
