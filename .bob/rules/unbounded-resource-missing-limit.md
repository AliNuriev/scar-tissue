---
id: unbounded-resource-missing-limit
bug_class: unbounded-resource
source_incidents: [INC-002]
confidence: 0.92
created_at: 2026-05-02T14:00:00Z
scope: ["routes/**/*.js", "src/**/*.js", "services/**/*.js"]
detection: "\\.find\\(\\s*\\{[^}]*\\}\\s*\\)(?![\\s\\S]{0,100}(limit|take|slice|paginate))|for\\s*\\([^)]*\\bof\\b[^)]*\\)[\\s\\S]{0,300}?\\bawait\\b"
status: active
---

## Rule

Every collection-returning query must carry an explicit limit, and every
`for…of` loop that `await`s inside its body must either operate on a
pre-bounded collection or use concurrent batching with a fixed batch size.
A query with no upper bound and a sequential loop over an unbounded collection
are both forbidden.

## When this applies

Any function that issues a database query returning a collection, or that
iterates over a collection with `await` inside the loop body, when the
collection size is determined by data rather than by a caller-supplied or
hard-coded cap.

## Why

An endpoint that was stable for two years began timing out when enough users
accumulated enough history. The query fetched every record with no limit;
memory on the API nodes spiked on each request, and the endpoint slowed
gradually until it stopped responding entirely. A server restart did nothing
because the data remained. The fix required adding a default page cap and a
server-side maximum that the caller cannot override.

## Instead of this

```js
async function getItems(req, res) {
  const { ownerId } = req.params;

  const items = await Item.find({ ownerId });

  res.json(items);
}
```

```js
async function processAll(records) {
  for (const record of records) {
    await externalService.process(record.id);
  }
}
```

## Do this

```js
const MAX_PAGE = 50;

async function getItems(req, res) {
  const { ownerId } = req.params;
  const limit = Math.min(parseInt(req.query.limit, 10) || MAX_PAGE, MAX_PAGE);

  const items = await Item.find({ ownerId }, { limit });

  res.json(items);
}
```

```js
const BATCH_SIZE = 20;

async function processAll(records) {
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(r => externalService.process(r.id)));
  }
}
```

## Escape hatch

Permitted when the collection is provably bounded by external constraints
(for example, a join that can return at most one row per unique key, or an
admin-only migration script that runs once against a known small dataset).
Mark the bypass and explain the bound:

```js
// scar-tissue-allow: unbounded-resource-missing-limit — one row per user guaranteed by unique constraint
```
