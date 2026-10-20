"""Build the candidate frame from a SWE-rebench-format dataset (protocol section 4, "Frame"),
reading its parquet files directly with DuckDB, and write every candidate with the reason
each other instance was left out. Reads only: registers nothing, starts no run, calls no
model. The per-task checks that need a machine (validation, the planted runs) and the
audit come later; this is the mechanical first cut.

  python3 scripts/frame.py <dataset> <out.json>
  python3 scripts/frame.py <dir-of-parquet> <out.json> [dataset name]   (local files, as the workflow fetches them)

The filters, in order, each counted in the summary:
  1. the issue opened after the cutoff;
  2. at least one FAIL_TO_PASS test;
  3. not the author's own repositories;
  4. the PR adds or changes tests (a non-empty test patch);
  5. the fix is Python or JS/TS: every non-test file the gold patch touches has one of
     those extensions;
  6. the fix touches at most 3 non-test files;
  7. a permissive licence, where the dataset records one.
A filter the dataset has no column for is reported as not applied, never guessed. The
fixing PR's merge date is not in SWE-rebench; it is checked against GitHub later."""

import json
import re
import sys

import duckdb

CUTOFF = "2026-06-30T23:59:59"  # scripts/task.mjs CUTOFF, without the zone
AUTHOR_OWNERS = {"drdustinedwards"}
PY = (".py", ".pyi")
JS = (".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts")
PERMISSIVE = {"mit", "apache-2.0", "bsd-2-clause", "bsd-3-clause", "isc", "0bsd", "unlicense", "psf-2.0", "zlib", "bsl-1.0"}
TEST_PATH = re.compile(r"(^|/)(tests?|testing|__tests__|spec)(/|$)|(^|/)test_[^/]*$|_test\.[^/]+$|\.(test|spec)\.[^/]+$|(^|/)conftest\.py$")


def count(tests):
    if tests is None:
        return 0
    if isinstance(tests, str):
        tests = json.loads(tests) if tests.strip() else []
    return len(tests)


def patch_files(patch):
    return sorted(set(re.findall(r"^diff --git a/(\S+) b/", patch or "", flags=re.M)))


def language(files):
    if files and all(f.endswith(PY) for f in files):
        return "python"
    if files and all(f.endswith(JS) for f in files):
        return "js/ts"
    return None


def first(row, *names):
    for n in names:
        if n in row and row[n] not in (None, ""):
            return row[n]
    return None


def main():
    dataset, out = sys.argv[1], sys.argv[2]
    # The name the frame file records, when the dataset was read from local files.
    name = sys.argv[3] if len(sys.argv) > 3 else dataset
    con = duckdb.connect()
    # A local directory of parquet files stands in for the dataset in a dry run.
    path = f"{dataset}/**/*.parquet" if dataset.startswith((".", "/")) else f"hf://datasets/{dataset}@~parquet/**/*.parquet"
    source = f"read_parquet('{path}', filename=true, union_by_name=true)"
    split = r"regexp_extract(filename, '/([^/]+)/[^/]+\.parquet$', 1)"
    columns = [r[0] for r in con.sql(f"DESCRIBE SELECT * FROM {source}").fetchall()]
    print(f"# Frame from {name}\n\nColumns: {', '.join(columns)}\n")
    licence_col = next((c for c in ("license_name", "license", "licence") if c in columns), None)
    wanted = [c for c in ("instance_id", "repo", "created_at", "base_commit", "patch", "test_patch", "FAIL_TO_PASS", "PASS_TO_PASS", "problem_statement", "language", licence_col) if c and c in columns]
    select = ", ".join(f'CAST("{c}" AS VARCHAR) AS "{c}"' if c == "created_at" else f'"{c}"' for c in wanted)
    rows = con.sql(f"SELECT {split} AS split, {select} FROM {source} WHERE CAST(created_at AS VARCHAR) > '{CUTOFF}'").fetchall()
    names = ["split", *wanted]
    total = con.sql(f"SELECT count(*) FROM {source}").fetchone()[0]
    # The newest issue per split, so an empty frame can be told apart from a dataset that
    # simply ends before the cutoff.
    for part, n, newest in con.sql(f"SELECT {split}, count(*), max(CAST(created_at AS VARCHAR)) FROM {source} GROUP BY 1 ORDER BY 1").fetchall():
        print(f"- split {part}: {n} rows, newest issue {newest}")
    print()

    steps = ["after the cutoff", "has a FAIL_TO_PASS test", "not the author's repo", "changes tests", "Python or JS/TS fix", "at most 3 non-test files", "permissive licence"]
    kept = {s: 0 for s in steps}
    candidates, seen = [], set()
    for values in rows:
        row = dict(zip(names, values))
        if row["instance_id"] in seen:  # an instance listed in more than one split counts once
            continue
        seen.add(row["instance_id"])
        kept["after the cutoff"] += 1
        if count(row.get("FAIL_TO_PASS")) == 0:
            continue
        kept["has a FAIL_TO_PASS test"] += 1
        if row["repo"].split("/")[0].lower() in AUTHOR_OWNERS:
            continue
        kept["not the author's repo"] += 1
        if not (row.get("test_patch") or "").strip():
            continue
        kept["changes tests"] += 1
        fix_files = [f for f in patch_files(row.get("patch")) if not TEST_PATH.search(f)]
        lang = language(fix_files)
        if not lang:
            continue
        kept["Python or JS/TS fix"] += 1
        if len(fix_files) > 3:
            continue
        kept["at most 3 non-test files"] += 1
        licence = first(row, "license_name", "license", "licence")
        if licence_col and (licence or "").lower() not in PERMISSIVE:
            continue
        kept["permissive licence"] += 1
        candidates.append({
            "task_id": row["instance_id"],
            "dataset_split": row["split"],
            "repo": row["repo"],
            "issue_created_at": row["created_at"],
            "language": lang,
            "licence": licence,
            "fix_files": fix_files,
            "fail_to_pass_count": count(row.get("FAIL_TO_PASS")),
            "pass_to_pass_count": count(row.get("PASS_TO_PASS")),
        })

    candidates.sort(key=lambda c: c["task_id"])
    with open(out, "w") as f:
        json.dump({"dataset": name, "cutoff": CUTOFF, "licence_column": licence_col, "rows_total": total, "kept_after": kept, "candidates": candidates}, f, indent=1)
    print(f"{total} rows in all.\n")
    for s in steps:
        note = " (not applied: no licence column)" if s == "permissive licence" and not licence_col else ""
        print(f"- {s}: {kept[s]}{note}")
    print(f"\n{len(candidates)} candidates. The fixing PR's merge date is not in the dataset and is checked against GitHub next.")
    repos = sorted({c["repo"] for c in candidates})
    print(f"{len(repos)} repositories; {sum(c['language'] == 'python' for c in candidates)} Python, {sum(c['language'] == 'js/ts' for c in candidates)} JS/TS.")


if __name__ == "__main__":
    main()
