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
print(f"# {dataset}\n")
for name, total, newest in con.sql(f"SELECT {split}, count(*), max(CAST(created_at AS VARCHAR)) FROM {source} GROUP BY 1 ORDER BY 1").fetchall():
    print(f"- {name}: {total} rows, newest {newest}")
side = "<=" if before else ">"
rows = con.sql(f"""SELECT {split}, instance_id, repo, CAST(created_at AS VARCHAR), FAIL_TO_PASS, PASS_TO_PASS
  FROM {source} WHERE CAST(created_at AS VARCHAR) {side} '{CUTOFF}'
  ORDER BY CAST(created_at AS VARCHAR) DESC{" LIMIT 300" if before else ""}""").fetchall()
found = sorted(
    ({"split": s, "id": i, "repo": r, "created_at": c, "f2p": count(f), "p2p": count(p)} for s, i, r, c, f, p in rows),
    key=lambda x: x["f2p"] + x["p2p"],
)
found = [x for x in found if x["f2p"] > 0]
print(f"\n{len(found)} {'of the newest 300 before' if before else 'after'} the cutoff with failing tests to fix\n")
for x in found[:60]:
    print(f"- {x['split']} | {x['id']} | {x['repo']} | {x['created_at']} | f2p {x['f2p']} p2p {x['p2p']}")
