// The audit packets and the second reader (protocol section 4, step 6): never the gold patch.

import { retryingFetch } from "./net.mjs";
import { sha256 } from "./seed.mjs";

// The fixed exclusion list (protocol section 4, step 6), by the code a reader writes.
export const REASONS = {
  "tests-not-issue": "the tests do not test the issue",
  "issue-states-solution": "the frozen issue states the solution",
  "network-or-time": "the tests depend on network or time",
  ambiguous: "the issue is ambiguous between incompatible fixes",
  "tests-reject-valid":
    "the issue states what a fix must do, and the tests reject a reasonable fix that does it, because they require an exact message, output or name that the issue neither gives nor requires and that such a fix could reasonably choose differently. A name the issue mentions, or one the tests call that clearly exists already, is not this reason",
};

// The second reader's response. It marks the task out only when it says out and names
// exactly one code on the list; anything else (an unknown code, a refusal, extra
// decisions) does not, and is recorded as no decision.
export function parseModelDecision(text) {
  const body = String(text ?? "").trim();
  const codes = Object.keys(REASONS).filter((code) =>
    new RegExp(`(^|[^a-z-])${code}([^a-z-]|$)`, "i").test(body),
  );
  if (/^`?out\b/i.test(body) && codes.length === 1) return { decision: "out", reason: codes[0] };
  if (/^`?in`?\s*$/i.test(body)) return { decision: "in" };
  return { decision: "none" };
}

export const PROMPT_PATH = new URL("../prompts/second-reader.md", import.meta.url);

// The second reader's prompt: the fixed list and the packet (protocol, "Second reader",
// revised 2026-10-22): the frozen issue, the repository, the hidden test names and the test
// patch. Never the gold patch, and nothing of the author's.
export function secondPrompt(template, instance) {
  const reasons = Object.entries(REASONS)
    .map(([code, text]) => `- ${code}: ${text}`)
    .join("\n");
  const task = [
    "<<<TASK",
    `Repository: ${instance.repo}`,
    "",
    "The issue:",
    instance.problem_statement,
    "",
    "The tests that judge a fix (they fail before the change and pass after it):",
    instance.FAIL_TO_PASS.join("\n"),
    "",
    "The test change:",
    instance.test_patch,
    "TASK>>>",
  ].join("\n");
  return template.replace("{{REASONS}}", reasons).replace("{{TASK}}", task);
}

// The registered second reader, from the environment.
export function secondReaderConfig(env, promptText) {
  const config = {
    url: env.SECOND_READER_URL ?? "",
    model: env.SECOND_READER_MODEL ?? "",
    prompt_sha256: sha256(promptText),
  };
  if (!config.url.startsWith("https://") || !config.model)
    throw new Error(
      "SECOND_READER_URL and SECOND_READER_MODEL must name the registered second reader",
    );
  if (/anthropic|claude/i.test(`${config.url} ${config.model}`))
    throw new Error("the second reader's vendor is not Anthropic");
  return config;
}

// One call, temperature 0. A transport failure (no response, 429 or 5xx) may be retried;
// a completed response is the decision and is never rerun.
export async function askSecondReader(config, prompt, key, fetchImpl = fetch) {
  const response = await retryingFetch(
    fetchImpl,
    config.url,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
    },
    {
      attempts: 5,
      baseMs: 5000,
      retryThrown: true,
      delay: (r, attempt) => (r.status === 429 || r.status >= 500 ? 5000 * 2 ** attempt : null),
    },
  );
  if (!response.ok) throw new Error(`the second reader answered ${response.status}`);
  return response.text();
}

// A reader's comment: `in`, or `out <code>` followed by the quoted reason.
export function parseDecision(text) {
  const body = String(text ?? "").trim();
  const m = body.match(/^(in|out)\b[ \t]*([a-z-]*)\s*([\s\S]*)$/i);
  if (!m) return null;
  const decision = m[1].toLowerCase();
  if (decision === "in") return m[2] || m[3] ? null : { decision };
  const reason = m[2].toLowerCase();
  const quote = m[3].trim();
  if (!REASONS[reason] || !quote) return null;
  return { decision, reason, quote };
}

// A fence longer than any run of backticks in the text, so nothing inside renders: no
// mention, no cross-reference to another repository, no markup.
export function fenced(text, lang = "") {
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

const LIMIT = 15000;
const clip = (text, link) =>
  text.length <= LIMIT
    ? text
    : `${text.slice(0, LIMIT)}\n… cut at ${LIMIT} characters; the whole file: ${link}`;

// The audit issue's text: the second reader's packet (the repository, the frozen issue,
// the hidden test names and the test patch), never the gold patch and never the other
// reader's decision (Grok's third review, 2026-10-22). A field too long for an issue is
// cut, with a link to the instance file, which does not hold the gold patch either.
export function auditBody(instance, fileUrl) {
  const reasons = Object.entries(REASONS)
    .map(([code, text]) => `- \`${code}\`: ${text}`)
    .join("\n");
  return [
    "Audit by the author, against the fixed exclusion list (protocol section 4, step 6).",
    "",
    "Answer with one comment: `in`, or `out <code>` followed by a quote from the issue or the tests that shows the reason. The first valid comment is recorded and closes this issue.",
    "",
    reasons,
    "",
    `Repository: ${fenced(instance.repo)}`,
    "",
    "### The frozen issue",
    fenced(clip(instance.problem_statement, fileUrl)),
    "",
    `### The tests that judge a fix (FAIL_TO_PASS, ${instance.FAIL_TO_PASS.length})`,
    fenced(clip(instance.FAIL_TO_PASS.join("\n"), fileUrl)),
    "",
    "### The test change",
    fenced(clip(instance.test_patch, fileUrl), "diff"),
  ].join("\n");
}
