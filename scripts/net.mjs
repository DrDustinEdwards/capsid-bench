// The two things every script that calls GitHub or another API repeats: the request headers
// and the retry with backoff. Plain Node, no packages (CLAUDE.md: scripts carry none).

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function githubHeaders(token, userAgent) {
  return {
    Authorization: `bearer ${token}`,
    "User-Agent": userAgent,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// The status GitHub sends for a rate limit or an outage.
export const rateLimitedOrDown = (status) => status === 403 || status === 429 || status >= 500;

// fetch, tried again while `delay(response, attempt)` returns a wait in milliseconds (it may
// be async; null or undefined means the answer stands). After `attempts` retries the last
// response is returned for the caller to judge. With `retryThrown`, a thrown transport
// failure is retried on the same schedule, `baseMs * 2 ** attempt`.
export async function retryingFetch(
  fetchImpl,
  url,
  init,
  { attempts, delay, baseMs = 0, retryThrown = false, wait = sleep },
) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (err) {
      if (!retryThrown || attempt >= attempts) throw err;
      await wait(baseMs * 2 ** attempt);
      continue;
    }
    const ms = attempt < attempts ? await delay(response, attempt) : null;
    if (ms == null) return response;
    await wait(ms);
  }
}
