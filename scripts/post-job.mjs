#!/usr/bin/env node
// Post the treatment's task as a signed Capsid job in the bench namespace, over MCP on
// /ops/mcp with the bench driver key, and print the job id.
//
//   BENCH_DRIVER_KEY=... node scripts/post-job.mjs <run_id> <task_id> <problem.md>
//
// The driver key only posts; the agent never holds it, and works the job with its run's
// own key. Capsid's /bench/score closes the job when it scores the run (protocol section
// 4, "The job"), so nothing here closes it.
//
// The title carries the run id, which is how Capsid checks the job is this run's when it
// scores it (src/bench.ts). The body follows prompts/job-body.md, Capsid's
// own GOAL / DO / OUT OF SCOPE / DONE WHEN layout, with the fenced issue inserted.

import { readFileSync } from "node:fs";
import { withIssue } from "./issue.mjs";

// The job's body: Capsid's GOAL / DO / OUT OF SCOPE / DONE WHEN layout around the issue,
// fenced exactly as the baseline receives it (scripts/issue.mjs).
export function jobBody(problem, taskId) {
  return withIssue("job-body.md", problem, taskId);
}

// A Streamable HTTP answer is JSON or an event stream; either way the JSON-RPC result is
// the payload of the last "data:" line or the body itself.
export function rpcPayload(text) {
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  return JSON.parse(data.length ? data.at(-1) : text);
}

async function rpc(url, key, session, message) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${key}`,
      ...(session ? { "Mcp-Session-Id": session } : {}),
    },
    body: JSON.stringify(message),
  });
  if (!response.ok) throw new Error(`${message.method} answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const text = await response.text();
  return { session: response.headers.get("mcp-session-id") ?? session, payload: text ? rpcPayload(text) : null };
}

async function call(url, key, args) {
  const init = await rpc(url, key, null, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "capsid-bench", version: "1" } },
  });
  await rpc(url, key, init.session, { jsonrpc: "2.0", method: "notifications/initialized" });
  const answer = await rpc(url, key, init.session, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "capsid_work_jobs", arguments: args } });
  return { text: answer.payload?.result?.content?.find((c) => c.type === "text")?.text ?? "", isError: Boolean(answer.payload?.result?.isError) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [runId, taskId, problemFile] = process.argv.slice(2);
  const key = process.env.BENCH_DRIVER_KEY;
  if (!key) {
    console.error("post-job: BENCH_DRIVER_KEY is not set");
    process.exit(2);
  }
  const url = `${process.env.CAPSID_URL ?? "https://mcp.dustinedwards.info"}/ops/mcp`;
  const posted = await call(url, key, {
    action: "post",
    namespace: "bench",
    kind: "build",
    title: `bench ${taskId} ${runId}`,
    body: jobBody(readFileSync(problemFile, "utf8"), taskId),
  });
  const id = /job_[0-9a-f]{12}/.exec(posted.text)?.[0];
  if (posted.isError || !id) {
    console.error(`post-job: the post was refused: ${posted.text.slice(0, 500)}`);
    process.exit(1);
  }
  process.stdout.write(id);
}
