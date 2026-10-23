"""The harness's check of a treatment run's reproduction test (protocol section 2,
"Prove it before done"), at the phase break, outside both phase clocks.

  python3 scripts/repro.py tasks/<task>.json diff.patch repro-name out.json

The agent names one new test file with bench-repro. The check splits the agent's diff
into that file and the rest, then runs the benchmark harness's own eval script with
only that file as the test patch: once on the base (no other change) and once with the
rest of the diff. The recipe's log parser reads each run. The check passes when at
least one test in the file FAILED on the base, not on an import or syntax error, and
every one of those tests PASSED with the diff. Anything else is a refusal with a reason
the agent sees when Capsid refuses its complete. It never sees the hidden tests, and
the result touches neither the claim nor the score.

The result is written as {"passed": bool, "reason": str} for /bench/repro."""

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

TIMEOUT = 1800
# A base failure raised before the test could exercise the bug: the test imports or
# parses something the fix adds. pytest's short summary line names the exception, and a
# JavaScript runner's names the module.
NOT_A_REPRODUCTION = re.compile(r"ImportError|ModuleNotFoundError|SyntaxError|Cannot find module")


def split_diff(diff, path):
    """The agent's diff as (that file's part, the rest). The file's part is None unless
    the diff adds it as a new file."""
    parts = re.split(r"(?m)^(?=diff --git )", diff)
    mine, rest = [], []
    for part in parts:
        if not part:
            continue
        header = part.splitlines()[0]
        (mine if header == f"diff --git a/{path} b/{path}" else rest).append(part)
    if len(mine) != 1 or not re.search(r"(?m)^new file mode ", mine[0]):
        return None, diff
    return mine[0], "".join(rest)


def error_line(log):
    """The test command's last error line in an eval log, else its last line."""
    body = log.split(">>>>> Start Test Output")[-1].split(">>>>> End Test Output")[0]
    lines = [l.strip() for l in body.splitlines() if l.strip() and not l.startswith("+ ")]
    errors = [l for l in lines if re.search(r"Error|ERROR", l) and not l.startswith("=")]
    return (errors or lines or ["(none)"])[-1]


def verdict(base, base_log, head):
    """(passed, reason) from the parser's two status maps, or None for a run it could not read."""
    if base is None:
        return False, "the check could not run your test on the base"
    failed = sorted(t for t, s in base.items() if s == "FAILED")
    if not failed:
        # What the base run did see, so the agent can tell a test that passed from one
        # that was skipped or never collected. These are its own tests, never hidden ones.
        seen = ", ".join(f"{sum(1 for s in base.values() if s == k)} {k.lower()}" for k in sorted(set(base.values())))
        if not seen:
            # Nothing the parser could read: quote the run's last error line, which is from the
            # agent's own test's output (the only test file in this run), not a hidden one.
            seen = f"no tests; it ended with: {error_line(base_log)[:200]}"
        return False, f"your test did not fail on the base (the base run saw: {seen})"
    real = [t for t in failed if not any(t in line and NOT_A_REPRODUCTION.search(line) for line in base_log.splitlines())]
    if not real:
        return False, "your test failed on the base only on an import or syntax error, not on the issue"
    if head is None:
        return False, "the check could not run your test on your diff"
    still = [t for t in real if head.get(t) != "PASSED"]
    if still:
        return False, f"your test did not pass on your diff ({len(still)} of {len(real)} failing tests still do not pass)"
    return True, f"your test failed on the base and passed on your diff ({len(real)} test{'s' if len(real) != 1 else ''})"


def run(image, eval_script, patch, parse):
    """One offline run, as scripts/validate.py does it, returning the status map and the log."""
    with tempfile.TemporaryDirectory() as tmp:
        Path(tmp, "eval.sh").write_text(eval_script)
        Path(tmp, "patch.diff").write_text(patch or "")
        name = f"repro-{Path(tmp).name}"
        subprocess.run(["docker", "run", "-d", "--name", name, "--network", "none", image, "sleep", "infinity"], check=True, capture_output=True)
        try:
            subprocess.run(["docker", "cp", f"{tmp}/eval.sh", f"{name}:/eval.sh"], check=True, capture_output=True)
            if patch:
                subprocess.run(["docker", "cp", f"{tmp}/patch.diff", f"{name}:/tmp/patch.diff"], check=True, capture_output=True)
                if subprocess.run(["docker", "exec", "-w", "/testbed", name, "git", "apply", "/tmp/patch.diff"], capture_output=True).returncode != 0:
                    return None, ""
            try:
                out = subprocess.run(["docker", "exec", name, "/bin/bash", "-c", "/bin/bash /eval.sh 2>&1"], capture_output=True, timeout=TIMEOUT)
            except subprocess.TimeoutExpired:
                return None, ""
            log = out.stdout.decode("utf-8", "replace")
            Path(tmp, "test_output.txt").write_text(log)
            status, ok = parse(str(Path(tmp, "test_output.txt")))
            return (status if ok else None), log
        finally:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True)


def check(task, diff, name):
    if task.get("source") == "own":
        return False, "this task has no reproduction check"
    if not name:
        return False, "no test was named with bench-repro"
    mine, rest = split_diff(diff, name)
    if mine is None:
        return False, f"{name} is not a new file in your diff"
    from swebench.harness.grading import get_logs_eval
    from swebench.harness.test_spec.test_spec import make_test_spec
    from swebench.harness.utils import _clean_install_config, load_swebench_dataset

    instance = load_swebench_dataset(task["harness"]["dataset"], task["harness"]["split"], [task["task_id"]])[0]
    instance = _clean_install_config(instance)
    instance["test_patch"] = mine
    spec = make_test_spec(instance, namespace=None)
    parse = lambda path: get_logs_eval(spec, path)
    base, base_log = run(task["image"], spec.eval_script, None, parse)
    head = None
    if base is not None:
        head, _ = run(task["image"], spec.eval_script, rest or None, parse)
    return verdict(base, base_log, head)


def main():
    task_path, diff_path, name_path, out_path = sys.argv[1:5]
    task = json.loads(Path(task_path).read_text())
    diff = Path(diff_path).read_text() if Path(diff_path).exists() else ""
    name = Path(name_path).read_text().strip() if Path(name_path).exists() else ""
    try:
        passed, reason = check(task, diff, name)
    except Exception as err:  # the machine, not the agent: say so rather than guess
        passed, reason = False, f"the check itself failed ({type(err).__name__})"
    Path(out_path).write_text(json.dumps({"passed": passed, "reason": reason}) + "\n")
    print(f"repro check: {'passed' if passed else 'not passed'}")


if __name__ == "__main__":
    main()
