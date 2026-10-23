"""Development only, on excluded tasks: scores saved diffs against tests a second agent
wrote from the issue alone (bench-writer.yml). It tells whether such tests separate the
runs that fixed the issue from those that did not, before any change to the treatment.

  python3 scripts/writer-check.py tasks/<task>.json writer.patch out.json label=diff.patch ...

The writer's new files are the test patch. Each diff runs once, through the benchmark
harness's own eval script, as scripts/repro.py does it; the gold patch and the base run
too. A writer test counts when it FAILED on the base and PASSED on gold. A diff passes
when every counted test PASSED on it. The output holds counts only, never a hidden test."""

import json
import re
import sys
from pathlib import Path

from repro import run, without_task_tests


def files_of(patch):
    return set(re.findall(r"(?m)^diff --git a/(\S+) b/", patch))


def drop(diff, paths):
    """The diff without its parts for any of `paths`."""
    parts = re.split(r"(?m)^(?=diff --git )", diff)
    return "".join(p for p in parts if p and not any(p.startswith(f"diff --git a/{x} b/{x}") for x in paths))


def main():
    task_path, writer_path, out_path, *diffs = sys.argv[1:]
    task = json.loads(Path(task_path).read_text())
    writer = Path(writer_path).read_text()
    out = {"writer_files": len(files_of(writer))}
    if not writer.strip():
        Path(out_path).write_text(json.dumps({**out, "error": "the writer wrote no new file"}) + "\n")
        return
    from swebench.harness.grading import get_logs_eval
    from swebench.harness.test_spec.test_spec import make_test_spec
    from swebench.harness.utils import _clean_install_config, load_swebench_dataset

    instance = load_swebench_dataset(task["harness"]["dataset"], task["harness"]["split"], [task["task_id"]])[0]
    instance = _clean_install_config(instance)
    instance["test_patch"] = writer
    config = instance.get("install_config")
    if isinstance(config, dict) and config.get("test_cmd"):
        config["test_cmd"] = without_task_tests(config["test_cmd"], task)
    spec = make_test_spec(instance, namespace=None)
    parse = lambda path: get_logs_eval(spec, path)
    mine = files_of(writer)

    def statuses(patch):
        # The eval script adds the writer's files itself, as the test patch.
        status, _ = run(task["image"], spec.eval_script, drop(patch, mine) if patch else None, parse)
        return status

    base = statuses(None)
    gold = statuses(task["gold_patch"])
    if base is None or gold is None:
        Path(out_path).write_text(json.dumps({**out, "error": "the base or gold run could not be read"}) + "\n")
        return
    failing = {t for t, s in base.items() if s == "FAILED"}
    counted = {t for t in failing if gold.get(t) == "PASSED"}
    out.update(writer_tests=len(base), fail_on_base=len(failing), counted=len(counted), wrong_on_gold=len(failing - counted))
    out["diffs"] = {}
    for item in diffs:
        label, path = item.split("=", 1)
        status = statuses(Path(path).read_text())
        out["diffs"][label] = None if status is None else sum(1 for t in counted if status.get(t) != "PASSED")
    Path(out_path).write_text(json.dumps(out) + "\n")
    print(json.dumps(out))


if __name__ == "__main__":
    main()
