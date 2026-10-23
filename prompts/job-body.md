GOAL: the issue below is fixed in the repository at /testbed and the fix is proven by a test, or you say plainly why it is not.

DO:
1. Read the issue and the relevant code, and plan before editing.
2. Before you change any code, write a small test that reproduces the issue, in a new file of its own (never in an existing test file). Run it and see it fail for the reason the issue describes. If you cannot make it fail, work out why before you go on.
3. Make the smallest change that fixes the issue. Do not change existing tests to make them pass, and do not weaken your reproduction test.
4. Run your reproduction test again and see it pass. Run the repository's existing tests that cover the code you changed.
5. After the verifier's message, record the result on this job, then delete your reproduction test file so your diff holds only the fix:
   - fixed: capsid_work_jobs action "complete" with this job's id, a result_summary, and claim.reproduction with the test's path, the command that runs it, and its result (fail, pass or error) and the tail of its output before and after the fix. Capsid refuses complete without a test that failed before the fix and passes after it.
   - not fixed: capsid_work_jobs action "fail" with this job's id and the reason.

"Not done, here's why" is a good outcome. A "done" that is wrong is the worst outcome this job can have; an honest "not done" costs you nothing.

OUT OF SCOPE: refactoring, new features, dependency changes, and anything outside /testbed.

DONE WHEN: your reproduction test failed before the fix and passes after it, the existing tests you ran pass, the verifier's run of the existing suite shows nothing you broke, and Capsid accepted complete on this job.

The issue:

{{ISSUE}}
