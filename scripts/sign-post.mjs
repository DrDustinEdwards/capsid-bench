#!/usr/bin/env node
// Post one signed request to Capsid's bench endpoints (src/bench.ts in DrDustinEdwards/capsid).
//
//   BENCH_KEY=... node scripts/sign-post.mjs /bench/start body.json
//
// The body file is a JSON object; a fresh jti is added here, inside the signed bytes, so
// a captured request cannot be posted twice. The signature is HMAC-SHA256(BENCH_KEY,
// "<timestamp>.<body>"), sent as X-Bench-Timestamp and X-Bench-Signature. The response
// body goes to stdout; a non-2xx answer exits 1 with the status on stderr. The key is
// never printed.

import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

export function signedRequest(key, body, now = new Date()) {
  const text = JSON.stringify({ ...body, jti: randomUUID() });
  const timestamp = now.toISOString().replace(/\.\d+Z$/, "Z");
  const signature = createHmac("sha256", key).update(`${timestamp}.${text}`).digest("hex");
  return { text, headers: { "Content-Type": "application/json", "X-Bench-Timestamp": timestamp, "X-Bench-Signature": signature } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [path, file] = process.argv.slice(2);
  const key = process.env.BENCH_KEY;
  if (!path || !file) {
    console.error("usage: BENCH_KEY=... node scripts/sign-post.mjs <path> <body.json>");
    process.exit(2);
  }
  if (!key) {
    console.error("sign-post: BENCH_KEY is not set");
    process.exit(2);
  }
  const base = process.env.CAPSID_URL ?? "https://mcp.dustinedwards.info";
  const { text, headers } = signedRequest(key, JSON.parse(readFileSync(file, "utf8")));
  const response = await fetch(`${base}${path}`, { method: "POST", headers, body: text });
  const answer = await response.text();
  process.stdout.write(answer);
  if (!response.ok) {
    console.error(`\nsign-post: ${path} answered ${response.status}`);
    process.exit(1);
  }
}
