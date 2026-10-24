GOAL: the issue below is fixed in the repository at /testbed and the fix is proven by a test, or you say plainly why it is not.

DO:
1. Read the issue and the relevant code, and plan before editing.
2. Before you change any code, write a test that reproduces the issue, in a new file of its own (never in an existing test file). List every behaviour the issue asks for (each case, option, input and expected result it names) and give each one an assertion; a test of only the first case is not enough. Where the issue asks for more than one fix ("both", "also", "ideally"), each fix is a behaviour of its own; where it offers alternatives ("either"), one is enough. Name it with `bench-repro <path>`. Run it and see it fail for the reason the issue describes, as a test failure, not an import or syntax error. If the issue asks for something that does not exist yet, import the module that does exist, assert that the new name is missing, and then assert the behaviour the issue asks for, so the base fails on an assertion. If you cannot make it fail, work out why before you go on.
3. Make the smallest change that fixes the issue. Do not change existing tests to make them pass, and do not weaken your reproduction test.
4. Run your reproduction test again and see it pass. Re-read the issue line by line against your test: anything it asks for that no assertion checks means the work is not done yet. Run the repository's existing tests that cover the code you changed. Keep the test file in place until the end of the work: when phase one ends, the harness runs the file you named on the original code with only that file added, and again on your diff, and tells Capsid whether it failed there and passed here.
5. After the verifier's message, record the result on this job, then delete that one new reproduction test file, and nothing else, so your diff holds only the fix:
   - fixed: capsid_work_jobs action "complete" with this job's id and a result_summary. Capsid accepts it only if the harness saw your named test fail on the original code and pass on your diff; if it refuses, its message says what the harness saw.
   - not fixed: capsid_work_jobs action "fail" with this job's id and the reason. Fail is the record after your new test was run and a fix was attempted, saying why it is still wrong, not a way to stop early.
6. Then claim: `bench-claim done` only after Capsid has accepted complete on this job; `bench-claim not-done` when you failed the job or complete was refused.

A "done" that is wrong is the worst outcome this job can have. "Not done, here's why", after a real attempt, is a good outcome.

OUT OF SCOPE: refactoring, new features, dependency changes, and anything outside /testbed.

DONE WHEN: the harness saw your named reproduction test fail on the original code and pass on your diff, the existing tests you ran pass, the verifier's run of the existing suite shows nothing you broke, and Capsid accepted complete on this job.

The issue:

{{ISSUE}}
