#!/usr/bin/env node
// Post one signed request to Capsid's bench endpoints (src/bench.ts in DrDustinEdwards/capsid).
//
//   BENCH_KEY=... node scripts/sign-post.mjs /bench/start body.json [answer.json]
//
// The body file is a JSON object; a fresh jti is added here, inside the signed bytes, so
// a captured request cannot be posted twice. The signature is HMAC-SHA256(BENCH_KEY,
// "<timestamp>.<body>"), sent as X-Bench-Timestamp and X-Bench-Signature. The response
// body goes to answer.json when given and is otherwise dropped: the Actions log is public
// and an unsealed score answer carries the run's outcome. Only the status is printed. A 429
// or 5xx is tried again; any other non-2xx answer exits 1. The key is never printed.

import { createHmac, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isMain, retryingFetch } from "./net.mjs";

export function signedRequest(key, body, now = new Date()) {
  const text = JSON.stringify({ ...body, jti: randomUUID() });
  const timestamp = now.toISOString().replace(/\.\d+Z$/, "Z");
  const signature = createHmac("sha256", key).update(`${timestamp}.${text}`).digest("hex");
  return {
    text,
    headers: {
      "Content-Type": "application/json",
      "X-Bench-Timestamp": timestamp,
      "X-Bench-Signature": signature,
    },
  };
}

if (isMain(import.meta.url)) {
  const [path, file, answerFile] = process.argv.slice(2);
  const key = process.env.BENCH_KEY;
  if (!path || !file) {
    console.error(
      "usage: BENCH_KEY=... node scripts/sign-post.mjs <path> <body.json> [answer.json]",
    );
    process.exit(2);
  }
  if (!key) {
    console.error("sign-post: BENCH_KEY is not set");
    process.exit(2);
  }
  const base = process.env.CAPSID_URL ?? "https://mcp.dustinedwards.info";
  const { text, headers } = signedRequest(key, JSON.parse(readFileSync(file, "utf8")));
  const response = await retryingFetch(
    fetch,
    `${base}${path}`,
    { method: "POST", headers, body: text },
    {
      attempts: 3,
      delay: (r, attempt) => (r.status === 429 || r.status >= 500 ? 2000 * 2 ** attempt : null),
      baseMs: 2000,
      retryThrown: true,
    },
  );
  if (answerFile) writeFileSync(answerFile, await response.text());
  console.error(`sign-post: ${path} answered ${response.status}`);
  if (!response.ok) process.exit(1);
}
