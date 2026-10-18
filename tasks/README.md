# Task files

One JSON file per task, named `<task_id>.json`. `scripts/task.mjs check` enforces this format, and CI runs it on every file.

| Field | Meaning |
| --- | --- |
| `task_id` | The benchmark's instance id, or `own__<repo>__<pr>` for a real task. Letters, digits, `.`, `_`, `-`. |
| `source` | `swe-rebench`, `swe-bench-live` or `own` |
| `split` | `pilot`, `full` or `excluded`. The pilot's tasks are kept out of the full run. |
| `repo` | `owner/name` on GitHub |
| `issue_created_at` | When the issue was opened. Must be after 2026-06-30 (the model's cutoff) unless the split is `excluded`. |
| `base_commit` | The commit the agent starts from |
| `image` | The container image the task runs in |
| `problem_statement` | The issue text, the only part of this file the agent sees |
| `gold_patch` | The upstream fix, used only by `check-gold` |
| `fail_to_pass` | Hidden tests that fail at the base and must pass after the fix |
| `pass_to_pass` | Tests that pass at the base and must keep passing |

Benchmark tasks add `harness: { dataset, split, namespace }`, what the benchmark's harness loads the task by; their test lists are test ids.

Real tasks (`own`) add `fix_commit` (the merged fix), `hidden_files` (the test files that fix added, withheld from the agent) and `setup` (the install command, run with network before the agent starts). Their test lists are shell commands run in `/testbed` with no network; a command passes when it exits 0. Real tasks are merged pull requests in Dustin's public repos dated after 2026-06-30, weighted toward Enarratio; a shortfall is filled from his other public repos and reported.
