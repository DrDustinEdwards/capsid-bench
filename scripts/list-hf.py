"""List a Hugging Face dataset's instances created after the cutoff (or, with `before`, the
newest ones created before it: practice tasks for tuning, protocol section 2), reading its parquet
files directly with DuckDB (datasets-server's /rows rate-limits and /filter times out on
large sets). Prints the newest date per split so an empty list can be told apart from a
dataset that simply ends before the cutoff. Reads only: registers nothing, calls no model."""

import json
import re
import sys

import duckdb

CUTOFF = "2026-06-30T23:59:59"  # scripts/task.mjs CUTOFF, without the zone


def count(tests):
    if tests is None:
        return 0
    if isinstance(tests, str):
        tests = json.loads(tests) if tests.strip() else []
    return len(tests)


dataset = sys.argv[1]
before = len(sys.argv) > 2 and sys.argv[2] == "before"
con = duckdb.connect()
source = f"read_parquet('hf://datasets/{dataset}@~parquet/**/*.parquet', filename=true, union_by_name=true)"
split = r"regexp_extract(filename, '/([^/]+)/[^/]+\.parquet$', 1)"
# Read the files once: Hugging Face answers 429 when the same files are fetched again.
con.sql(f"""CREATE TABLE r AS SELECT {split} AS split, instance_id, repo, CAST(created_at AS VARCHAR) AS created,
  FAIL_TO_PASS, PASS_TO_PASS, patch, length(problem_statement) AS issue_chars FROM {source}""")
print(f"# {dataset}\n")
for name, total, newest in con.sql("SELECT split, count(*), max(created) FROM r GROUP BY 1 ORDER BY 1").fetchall():
    print(f"- {name}: {total} rows, newest {newest}")
side = "<=" if before else ">"
rows = con.sql(f"""SELECT split, instance_id, repo, created, FAIL_TO_PASS, PASS_TO_PASS, patch, issue_chars
  FROM r WHERE created {side} '{CUTOFF}'
  ORDER BY created DESC{" LIMIT 300" if before else ""}""").fetchall()
def size(patch):
    """Changed lines and files in the gold patch: how hard the fix is, for choosing practice tasks."""
    lines = (patch or "").splitlines()
    changed = sum(1 for l in lines if l[:1] in "+-" and not l.startswith(("+++", "---")))
    return changed, sum(1 for l in lines if l.startswith("diff --git"))


found = sorted(
    ({"split": s, "id": i, "repo": r, "created_at": c, "f2p": count(f), "p2p": count(p), "size": size(g), "issue": n or 0}
     for s, i, r, c, f, p, g, n in rows),
    # Practice wants the harder fixes first; the study keeps the cheapest test runs first.
    key=(lambda x: -x["size"][0]) if before else (lambda x: x["f2p"] + x["p2p"]),
)
# The dataset lists an instance under each split it falls in; keep its first row only.
seen = set()
found = [x for x in found if x["f2p"] > 0 and not (x["id"] in seen or seen.add(x["id"]))]
print(f"\n{len(found)} {'of the newest 300 before' if before else 'after'} the cutoff with failing tests to fix\n")
for x in found[:120]:
    print(f"- {x['split']} | {x['id']} | {x['repo']} | {x['created_at']} | f2p {x['f2p']} p2p {x['p2p']}"
          f" | gold {x['size'][0]} lines in {x['size'][1]} files | issue {x['issue']} chars")
