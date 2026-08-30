---
id: resource-leak-missing-finally
bug_class: resource-leak
source_incidents: [INC-005]
confidence: 0.91
created_at: 2026-02-19T15:00:00Z
scope: ["src/**/*.js", "services/**/*.js", "routes/**/*.js"]
detection: "(acquire|setInterval)\\([^;]*\\);\\n(?![ \\t]*try\\b)"
status: active
---

## Rule

Every resource acquired with `acquire()`, `setInterval()`, `addListener()`, or
`createReadStream()` must be released on every exit path. The release call must
live inside a `finally` block, or the acquire must be delegated to a scoped
helper that guarantees cleanup. Placing the release only after the last
successful `await` in the function body is forbidden.

## When this applies

Any function that acquires a resource — a connection, a timer, a file handle, or
an event listener — and later releases it. The rule applies when the acquire and
release are in the same function scope and there is at least one asynchronous
operation between them that can throw.

## Why

When an acquired resource is released only on the success path, any thrown error
between the acquire and the release silently retains the resource. Under normal
load this is invisible. Under sustained partial failure — a slow upstream, an
intermittent network error, a dependency returning 502s — the resources drain
one by one over hours until the pool or handle table is empty. A restart fixes
the symptom instantly, which makes the root cause easy to misdiagnose as
transient. The failure is undetectable in local testing because it requires
sustained error conditions, not a single bad call.

## Instead of this

```js
async function withResource(input) {
  const handle = await pool.acquire();

  const result = await doWork(handle, input);

  await pool.release(handle);
  return result;
}
```

## Do this

```js
async function withResource(input) {
  const handle = await pool.acquire();
  try {
    const result = await doWork(handle, input);
    return result;
  } finally {
    await pool.release(handle);
  }
}
```

## Escape hatch

Permitted when the acquire and release are guaranteed to run in a single-tick,
synchronous, non-throwing context where no error path exists (e.g. a counter
increment guarded by a synchronous conditional with no IO). Mark the bypass and
say why:

```js
// scar-tissue-allow: resource-leak-missing-finally — synchronous counter, no IO, cannot throw
```
