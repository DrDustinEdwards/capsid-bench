#!/usr/bin/env node
// The agent container's only way out: an HTTPS CONNECT proxy that opens a tunnel to an
// allowlisted host on port 443 and refuses everything else.
//
//   ALLOW=api.anthropic.com,mcp.dustinedwards.info node scripts/egress-proxy.mjs
//
// The task container sits on an internal Docker network with no route out; this proxy
// runs in a container on that network and on the default bridge. The benchmark
// datasets, and so the hidden tests and the upstream fixes, are public, so an agent
// with open egress could read them; this is what keeps "hidden" true. Every decision is
// logged as ALLOW or DENY with the host, so the run's log shows any host Claude Code
// needed and did not get. It never decrypts anything: a CONNECT tunnel carries TLS end
// to end.

import { createServer } from "node:http";
import { connect } from "node:net";

export function allowed(target, allowlist) {
  const match = /^([a-z0-9.-]+):(\d+)$/i.exec(target ?? "");
  if (!match) return false;
  return match[2] === "443" && allowlist.includes(match[1].toLowerCase());
}

export function startProxy(allowlist, port = 3128, log = (line) => console.log(line)) {
  const server = createServer((req, res) => {
    // Plain HTTP is never forwarded: every allowed host speaks HTTPS.
    log(`DENY ${req.method} ${req.url}`);
    res.writeHead(403).end("plain HTTP is not allowed\n");
  });
  server.on("connect", (req, client, head) => {
    if (!allowed(req.url, allowlist)) {
      log(`DENY CONNECT ${req.url}`);
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    log(`ALLOW CONNECT ${req.url}`);
    const [host, targetPort] = req.url.split(":");
    const upstream = connect(Number(targetPort), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const allowlist = (process.env.ALLOW ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length === 0) {
    console.error("egress-proxy: ALLOW is empty, so nothing could get out; refusing to start");
    process.exit(2);
  }
  await startProxy(allowlist, Number(process.env.PORT ?? 3128));
  console.log(`egress-proxy: listening, allowing ${allowlist.join(", ")}`);
}
