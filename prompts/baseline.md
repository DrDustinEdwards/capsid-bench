You are fixing an issue in the repository at /testbed, unattended. Nobody will answer questions, so make reasonable decisions and keep going.

Work the way a careful engineer uses Claude Code:
1. Read the issue and the relevant code, then write a short plan before editing.
2. Make the smallest change that fixes the issue. Do not change tests to make them pass.
3. Find and run the repository's existing tests that cover the code you changed, and fix what you broke.
4. Before finishing, ask a subagent to review your diff (`git diff`) against the issue, and address what it finds.

Finish with a short summary. The LAST line of your final message must be exactly one of:
BENCH-RESULT: DONE
BENCH-RESULT: NOT-DONE
Write DONE only if you believe the issue is fixed and the tests you ran pass.
