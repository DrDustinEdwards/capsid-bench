import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from mutants import mutants  # noqa: E402

BEFORE = {
    "pkg/core.py": "def area(w, h):\n    return w * h\n\n\ndef ok(x):\n    return x > 0\n" + "\n" * 20 + "def name(s):\n    return s\n",
    "web/app.js": "function on(a, b) {\n  return a;\n}\n",
}
AFTER = {
    "pkg/core.py": "def area(w, h):\n    if w < 0 or h < 0:\n        raise ValueError('negative')\n    return w * h\n\n\ndef ok(x):\n    return x >= 0\n" + "\n" * 20 + "def name(s):\n    s = s.strip()\n    return s\n",
    "web/app.js": "function on(a, b) {\n  return a && !b;\n}\n",
    "tests/test_core.py": "def test_area():\n    assert True\n",
}


def git(repo, *args, **kw):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, **kw)


class Mutants(unittest.TestCase):
    # The diff arithmetic is the tricky part: a mutant that git cannot apply, or that
    # silently equals the fix, would read as a lax or a strong test when it is neither.
    def test_every_mutant_applies_to_the_base_and_differs_from_the_fix(self):
        with tempfile.TemporaryDirectory() as repo:
            git(repo, "init", "-q")
            for path, text in BEFORE.items():
                Path(repo, path).parent.mkdir(parents=True, exist_ok=True)
                Path(repo, path).write_text(text)
            git(repo, "add", "-A")
            git(repo, "-c", "user.email=a@example.com", "-c", "user.name=a", "commit", "-qm", "base")
            for path, text in AFTER.items():
                Path(repo, path).parent.mkdir(parents=True, exist_ok=True)
                Path(repo, path).write_text(text)
            git(repo, "add", "-A")
            diff = git(repo, "diff", "--cached").stdout
            git(repo, "reset", "-q", "--hard")

            found = mutants(diff)
            descriptions = [d for d, _, _ in found]
            self.assertTrue(any("without hunk" in d for d in descriptions))
            self.assertTrue(any("flip a comparison" in d for d in descriptions))
            self.assertTrue(any("web/app.js" in d for d in descriptions))
            self.assertFalse(any("tests/" in d for d in descriptions))
            self.assertLessEqual(len(found), 10)
            for desc, patch, _ in found:
                self.assertNotEqual(patch, diff, desc)
                applied = git(repo, "apply", "--check", "-", input=patch)
                self.assertEqual(applied.returncode, 0, f"{desc}: {applied.stderr}")


if __name__ == "__main__":
    unittest.main()
