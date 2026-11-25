// The content digest of a Docker Hub image tag, so a task file names the exact image it
// ran and a moved tag cannot swap what holds the run's credentials.
//
//   node scripts/image-digest.mjs swerebench/sweb.eval.x86_64.a_1776_b-1:latest
//     -> swerebench/sweb.eval.x86_64.a_1776_b-1:latest@sha256:...
import { isMain, retryingFetch } from "./net.mjs";

const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const retry = {
  attempts: 4,
  delay: (r, n) => (r.status === 429 || r.status >= 500 ? 2000 * 2 ** n : null),
};

export async function pinImage(image, fetchImpl = fetch) {
  if (/@sha256:[0-9a-f]{64}$/.test(image)) return image;
  const [name, tag = "latest"] = image.split(/:(?=[^/]*$)/);
  const repo = name.includes("/") ? name : `library/${name}`;
  const auth = await retryingFetch(
    fetchImpl,
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`,
    undefined,
    retry,
  );
  if (!auth.ok) throw new Error(`${image}: the registry token answered ${auth.status}`);
  const { token } = await auth.json();
  const manifest = await retryingFetch(
    fetchImpl,
    `https://registry-1.docker.io/v2/${repo}/manifests/${tag}`,
    { method: "HEAD", headers: { Authorization: `Bearer ${token}`, Accept: ACCEPT } },
    retry,
  );
  const digest = manifest.headers.get("docker-content-digest");
  if (!manifest.ok || !/^sha256:[0-9a-f]{64}$/.test(digest ?? ""))
    throw new Error(`${image}: the registry answered ${manifest.status} with no digest`);
  return `${name}:${tag}@${digest}`;
}

if (isMain(import.meta.url)) {
  for (const image of process.argv.slice(2)) console.log(await pinImage(image));
}
