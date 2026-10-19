// The issue as both arms receive it (protocol section 2): inside Capsid's external fence
// (src/provenance.ts in capsid), so the reader can tell it from instructions and a
// "TODO:" in an issue is not refused as an unfilled placeholder. A line that would close
// the fence is escaped, as Capsid's own externalFence does. The baseline gets it in
// prompts/issue.md as its first message; the treatment gets it in its job's body,
// prompts/job-body.md. The fence and the issue text are the same bytes in both.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const prompts = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");

export function fenceIssue(problem, taskId) {
  const escaped = problem.replace(/^([ \t]{0,3})(~{3,})/gm, (_m, indent, tildes) => `${indent}\\${tildes}`);
  const ref = taskId.replace(/\s+/g, " ").slice(0, 120);
  return `~~~external source=issue ref=${ref}\n${escaped}\n~~~`;
}

// prompts/<name> with {{ISSUE}} replaced by the fenced issue.
export function withIssue(name, problem, taskId) {
  return readFileSync(join(prompts, name), "utf8").replace("{{ISSUE}}", () => fenceIssue(problem, taskId));
}
