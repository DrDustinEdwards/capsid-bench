"""Validation of one prepared candidate (protocol section 4, "Validation is three offline
reruns"), with the SWE-rebench harness (SWE-rebench/SWE-bench-fork, pinned in the
workflow) building the environment from the repository's recipe, unedited, at the base
commit.

  python3 scripts/validate.py instance.json out.json

Builds the instance image once, with network, as the harness does. Then runs the
harness's own eval script three times without the gold patch and three times with it,
each in a fresh container with no network, and reads each run with the recipe's log
parser. The hidden tests are the tests in the files the pull request's test patch
touches. A test fails before and passes after (FAIL_TO_PASS), or passes both
(PASS_TO_PASS); any other test is left out of both lists, as SWE-bench does.

The verdict is the first reason that applies, in the protocol's order:
  - no recipe; recipe not usable at the base commit (the harness could not make the
    build scripts from it, for example a requirements file it names is missing there);
    build failed (the image did not build);
  - did not fail before: no hidden test fails without the gold patch;
  - did not pass after: hidden tests fail without the gold patch, and none of them
    passes with it;
  - reruns disagreed: the three runs of either side did not give the same status map.
Otherwise the candidate passes, with its two test lists. One shot: no retry."""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

RERUNS = 3
TIMEOUT = 1800


def run(image, eval_script, patch, parse):
    """One offline run: a fresh container, the patch applied if any, the eval script."""
    with tempfile.TemporaryDirectory() as tmp:
        Path(tmp, "eval.sh").write_text(eval_script)
        Path(tmp, "patch.diff").write_text(patch or "")
        name = f"validate-{Path(tmp).name}"
        subprocess.run(["docker", "run", "-d", "--name", name, "--network", "none", image, "sleep", "infinity"], check=True, capture_output=True)
        try:
            subprocess.run(["docker", "cp", f"{tmp}/eval.sh", f"{name}:/eval.sh"], check=True, capture_output=True)
            if patch:
                subprocess.run(["docker", "cp", f"{tmp}/patch.diff", f"{name}:/tmp/patch.diff"], check=True, capture_output=True)
                applied = subprocess.run(["docker", "exec", "-w", "/testbed", name, "git", "apply", "--verbose", "/tmp/patch.diff"], capture_output=True)
                if applied.returncode != 0:
                    return None
            try:
                out = subprocess.run(["docker", "exec", name, "/bin/bash", "/eval.sh"], capture_output=True, timeout=TIMEOUT)
                log = out.stdout.decode("utf-8", "replace") + out.stderr.decode("utf-8", "replace")
            except subprocess.TimeoutExpired:
                return None
            log_path = Path(tmp, "test_output.txt")
            log_path.write_text(log)
            status, ok = parse(str(log_path))
            return status if ok else None
        finally:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True)


def lists(before, after, passed, failed):
    tests = sorted(set(before) | set(after))
    f2p = [t for t in tests if failed(t, before) and passed(t, after)]
    p2p = [t for t in tests if passed(t, before) and passed(t, after)]
    return f2p, p2p


def verdict(befores, afters, passed, failed):
    """The first failing gate, from the three runs of each side, or the two lists."""
    first_before, first_after = befores[0] or {}, afters[0] or {}
    f2p, p2p = lists(first_before, first_after, passed, failed)
    if not f2p:
        # A hidden test that fails on both sides is one the gold patch did not make pass;
        # with none, every hidden test already passed before it.
        both = [t for t in set(first_before) | set(first_after) if failed(t, first_before) and failed(t, first_after)]
        return {"verdict": "did not pass after" if both else "did not fail before"}
    if any(r is None for r in befores + afters) or any(r != befores[0] for r in befores) or any(r != afters[0] for r in afters):
        return {"verdict": "reruns disagreed"}
    return {"verdict": "passed", "FAIL_TO_PASS": f2p, "PASS_TO_PASS": p2p}


def main():
    instance_path, out_path = sys.argv[1], sys.argv[2]
    instance = json.loads(Path(instance_path).read_text())
    result = {"task_id": instance.get("instance_id") or instance.get("task_id")}
    if instance.get("excluded"):
        result["verdict"] = instance["excluded"]
        Path(out_path).write_text(json.dumps(result, indent=1) + "\n")
        print(f"{result['task_id']}: {result['verdict']}")
        return

    import docker
    from swebench.harness.docker_build import build_instance_images
    from swebench.harness.grading import get_logs_eval, test_failed, test_passed
    from swebench.harness.test_spec.test_spec import make_test_spec
    from swebench.harness.utils import _clean_install_config

    instance = _clean_install_config(instance)
    try:
        spec = make_test_spec(instance, namespace=None)
    except Exception as err:  # the harness could not turn the recipe into build scripts
        result.update(verdict="recipe not usable at the base commit", detail=str(err)[:500])
    else:
        client = docker.from_env(timeout=600)
        built, failed_builds = build_instance_images(client, [instance], max_workers=1)
        if failed_builds or not built:
            result.update(verdict="build failed")
        else:
            parse = lambda path: get_logs_eval(spec, path)
            befores = [run(spec.instance_image_key, spec.eval_script, None, parse) for _ in range(RERUNS)]
            afters = [run(spec.instance_image_key, spec.eval_script, instance["patch"], parse) for _ in range(RERUNS)]
            result.update(verdict(befores, afters, test_passed, test_failed))
            result["image"] = spec.instance_image_key
    Path(out_path).write_text(json.dumps(result, indent=1) + "\n")
    print(f"{result['task_id']}: {result['verdict']}")


if __name__ == "__main__":
    main()
