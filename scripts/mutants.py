"""The mutant check on a treatment run's reproduction test: does the test catch a broken
copy of the agent's own fix? A fail-then-pass check (scripts/repro.py) passes a lax test
too, one that still passes with half the fix gone ("Beyond Fail-to-Pass", arXiv
2607.19843). DEVELOPMENT ONLY until the protocol's section 2 says otherwise.

  python3 scripts/mutants.py tasks/<task>.json diff.patch repro-name out.json

Mutants are made from the diff alone, on the lines the fix changed (as Google's diff-based
mutation testing does), never by a model:

  - drop one source hunk, when the fix has more than one;
  - on one added line: flip a comparison, swap and/or, drop a not, swap True/False,
    return None instead of a value, or make the line a no-op.

Each mutant runs the repro test as repro.py runs it. A mutant that does not
parse (Python, or JavaScript where the image has node) is left out, not counted as caught. The result is
{"repro": {passed, reason}, "valid", "killed", "invalid", "survivors": [descriptions]};
the log shows counts only."""

import json
import re
import sys
from pathlib import Path

from repro import base_and_head, run

MAX_MUTANTS = 10
MAX_DROPS = 4
SOURCE = re.compile(r"\.(py|js|jsx|mjs|cjs|ts|tsx)$")
TESTLIKE = re.compile(r"(^|/)(tests?|testing|__tests__)/|(^|/)test_[^/]*$|_test\.[a-z]+$|\.(test|spec)\.[a-z]+$|(^|/)conftest\.py$")
COMMENT = re.compile(r"^\s*(#|//|/\*|\*|\"\"\"|'''|$)")
STRING = re.compile(r"\"(?:[^\"\\]|\\.)*\"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`")
HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$")


def parse(diff):
    """The diff as files, each {"path", "head": [lines], "hunks": [[header, lines...]], "new"}."""
    files = []
    for part in re.split(r"(?m)^(?=diff --git )", diff):
        if not part.strip():
            continue
        lines = part.split("\n")
        if lines and lines[-1] == "":
            lines.pop()
        m = re.match(r"diff --git a/(\S+) b/(\S+)", lines[0])
        f = {"path": m.group(2) if m else "", "head": [], "hunks": [], "new": False}
        for line in lines:
            if line.startswith("@@"):
                f["hunks"].append([line])
            elif f["hunks"]:
                f["hunks"][-1].append(line)
            else:
                f["head"].append(line)
                f["new"] = f["new"] or line.startswith("new file mode")
        files.append(f)
    return files


def recount(hunk):
    """The hunk with its header's line counts made true again."""
    m = HUNK.match(hunk[0])
    body = hunk[1:]
    old = sum(1 for l in body if l[:1] in (" ", "-"))
    new = sum(1 for l in body if l[:1] in (" ", "+"))
    return [f"@@ -{m.group(1)},{old} +{m.group(3)},{new} @@{m.group(5)}"] + body


def render(files):
    out = []
    for f in files:
        out += f["head"]
        for h in f["hunks"]:
            out += recount(h)
    return "\n".join(out) + "\n"


def source(f):
    return bool(SOURCE.search(f["path"])) and not TESTLIKE.search(f["path"])


def meaningful(hunk):
    return any(l[:1] in "+-" and not COMMENT.match(l[1:]) for l in hunk[1:])


def outside_strings(text, fn):
    """fn applied to the first code span (outside string literals and a trailing comment)
    it changes, else None."""
    spans, last = [], 0
    for m in STRING.finditer(text):
        spans.append((last, m.start()))
        last = m.end()
    spans.append((last, len(text)))
    for a, b in spans:
        code = text[a:b]
        cut = min([i for i in (code.find(" #"), code.find("//")) if i >= 0] or [len(code)])
        changed = fn(code[:cut])
        if changed is not None and changed != code[:cut]:
            return text[:a] + changed + code[cut:] + text[b:]
    return None


def sub_once(pattern, repl):
    return lambda code: (re.sub(pattern, repl, code, count=1) if re.search(pattern, code) else None)


SWAPS = {"==": "!=", "!=": "==", "===": "!==", "!==": "===", "<=": "<", ">=": ">", " and ": " or ", " or ": " and ", "&&": "||", "||": "&&", "True": "False", "False": "True", "true": "false", "false": "true"}


def operators(line, py):
    """(description, new line) for each operator that applies to one added line."""
    out = []
    flips = [
        ("flip a comparison", sub_once(r"(?<![=!<>])(===|!==|==|!=|<=|>=)(?![=>])", lambda m: SWAPS[m.group(1)])),
        ("swap and/or", sub_once(r" and | or " if py else r"&&|\|\|", lambda m: SWAPS[m.group(0)])),
        ("drop a not", sub_once(r"\bnot\s+" if py else r"(?<![!=])!(?=[\w(])", "")),
        ("swap a boolean", sub_once(r"\b(True|False)\b" if py else r"\b(true|false)\b", lambda m: SWAPS[m.group(1)])),
    ]
    for desc, fn in flips:
        changed = outside_strings(line, fn)
        if changed is not None:
            out.append((desc, changed))
    indent = re.match(r"\s*", line).group(0)
    body = line.strip()
    if py:
        if re.match(r"return\s+\S", body) and body != "return None":
            out.append(("return None", f"{indent}return None"))
        elif not body.endswith((":", ",", "(", "[", "{", "\\")) and not re.match(r"(else|elif|except|finally|try|with|for|while|if|def|class|return|yield|raise|@|\)|\]|\})", body) and body.count("(") == body.count(")") and body.count("[") == body.count("]"):
            out.append(("make the line a no-op", f"{indent}pass"))
    else:
        if re.match(r"return\s+[^;]+;?$", body) and not body.startswith("return undefined"):
            out.append(("return undefined", f"{indent}return undefined;"))
        elif body.endswith(";") and not re.search(r"[{}]", body) and body.count("(") == body.count(")"):
            out.append(("make the line a no-op", ""))
    return out


def mutants(diff):
    """[(description, patch, files to parse-check)] for the source part of a diff, at
    most MAX_MUTANTS: hunk drops first, then line operators taken in turn across hunks."""
    files = parse(diff)
    hunks = [(fi, hi) for fi, f in enumerate(files) if source(f) for hi, h in enumerate(f["hunks"]) if meaningful(h)]
    parsed = lambda fi: [files[fi]["path"]] if re.search(r"\.(py|js|mjs|cjs)$", files[fi]["path"]) else []
    drops = []
    if len(hunks) > 1:
        for fi, hi in hunks:
            if files[fi]["new"]:
                continue
            copy = [dict(f, hunks=list(f["hunks"])) for f in files]
            del copy[fi]["hunks"][hi]
            copy = [f for f in copy if f["hunks"] or not f["head"] or not any(l.startswith("---") for l in f["head"])]
            drops.append((f"{files[fi]['path']}: without hunk {hi + 1}", render(copy), parsed(fi)))
    per_hunk = []
    for fi, hi in hunks:
        found = []
        for li, line in enumerate(files[fi]["hunks"][hi]):
            if li == 0 or not line.startswith("+") or COMMENT.match(line[1:]):
                continue
            for desc, new in operators(line[1:], files[fi]["path"].endswith(".py")):
                copy = [dict(f, hunks=[list(h) for h in f["hunks"]]) for f in files]
                copy[fi]["hunks"][hi][li] = "+" + new
                found.append((f"{files[fi]['path']}: {desc} (hunk {hi + 1})", render(copy), parsed(fi)))
        per_hunk.append(found)
    chosen = drops[:MAX_DROPS]
    while len(chosen) < MAX_MUTANTS and any(per_hunk):
        for found in per_hunk:
            if found and len(chosen) < MAX_MUTANTS:
                chosen.append(found.pop(0))
    return chosen


def compile_command(path):
    """A shell check that the mutated file still parses: Python's compiler, or node's for
    JavaScript when the image has node (TypeScript is left to the test run)."""
    if path.endswith(".py"):
        return f"python -m py_compile '{path}'"
    return f"{{ ! command -v node >/dev/null || node --check '{path}'; }}"


def check(task, diff, name):
    (passed, reason), seen = base_and_head(task, diff, name)
    result = {"repro": {"passed": passed, "reason": reason}, "valid": 0, "killed": 0, "invalid": 0, "survivors": []}
    if not passed:
        return result
    real = [t for t, s in seen["base"].items() if s == "FAILED" and seen["head"].get(t) == "PASSED"]
    for desc, patch, parsed in mutants(seen["rest"]):
        compile_cmd = " && ".join(compile_command(p) for p in parsed) or None
        status, _ = run(task["image"], seen["spec"].eval_script, patch, seen["parse"], check_cmd=compile_cmd)
        if status is None:
            result["invalid"] += 1
            continue
        result["valid"] += 1
        if any(status.get(t) != "PASSED" for t in real):
            result["killed"] += 1
        else:
            result["survivors"].append(desc)
    return result


def new_test_files(diff):
    """The test-like files a diff adds, for a saved run that did not keep the name."""
    return [f["path"] for f in parse(diff) if f["new"] and TESTLIKE.search(f["path"])]


def main():
    task_path, diff_path, name_path, out_path = sys.argv[1:5]
    task = json.loads(Path(task_path).read_text())
    diff = Path(diff_path).read_text() if Path(diff_path).exists() else ""
    name = Path(name_path).read_text().strip() if Path(name_path).exists() else ""
    names = [name] if name else new_test_files(diff)[:3]
    result = {"repro": {"passed": False, "reason": "no new test file"}, "valid": 0, "killed": 0, "invalid": 0, "survivors": []}
    for candidate in names:
        try:
            result = check(task, diff, candidate)
        except Exception as err:  # the machine, not the agent: say so rather than guess
            result = {**result, "repro": {"passed": False, "reason": f"the check itself failed ({type(err).__name__})"}}
        if result["repro"]["passed"]:
            break
    Path(out_path).write_text(json.dumps(result) + "\n")
    r = result
    print(f"repro {'passed' if r['repro']['passed'] else 'not passed'}; mutants killed {r['killed']} of {r['valid']} ({r['invalid']} invalid)")


if __name__ == "__main__":
    main()
