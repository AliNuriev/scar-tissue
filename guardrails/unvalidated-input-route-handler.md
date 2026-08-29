---
id: unvalidated-input-route-handler
bug_class: unvalidated-input
source_incidents: [INC-003]
confidence: 0.93
created_at: 2026-03-08T14:00:00Z
scope: ["routes/**/*.js", "src/**/*.js", "handlers/**/*.js"]
detection: "const\\s*\\{[^}]*\\}\\s*=\\s*req\\.(body|query|params)[\\s\\S]{0,300}?(\\.find|\\.query)\\s*\\("
status: active
---

## Rule

Every route handler must validate the type and presence of all external inputs
before any business logic, query, or computation runs. Direct use of destructured
`req.body`, `req.query`, or `req.params` values in a database call or arithmetic
expression is forbidden without an explicit validation boundary above it.

## When this applies

Any function that receives an HTTP request and reads fields from `req.body`,
`req.query`, or `req.params`, then uses those values in a database query,
arithmetic, or an outbound call. It does not apply to code that only reads
from validated internal state.

## Why

A partner client changed its payload format, sending a field as the wrong type
and omitting it entirely on certain requests. Because the handler passed the
values directly into a query, the arithmetic on the missing field produced `NaN`,
the query driver rejected it, and the handler returned 500 with no explanation.
The partner received no actionable error; the failure went unnoticed for eleven
hours. A 400 response naming the invalid field would have let the partner fix
their client immediately.

## Instead of this

```js
async function handleRequest(req, res) {
  const { quantity, itemId } = req.body;

  const results = await Item.find({ id: itemId });
  const total = results.map(r => r.price * quantity);
  res.json(total);
}
```

## Do this

```js
async function handleRequest(req, res) {
  const { quantity, itemId } = req.body;

  if (typeof itemId !== 'string' || !itemId ||
      typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({ error: 'Missing or invalid fields: itemId (string), quantity (integer >= 1)' });
  }

  const results = await Item.find({ id: itemId });
  const total = results.map(r => r.price * quantity);
  res.json(total);
}
```

Alternatively, validate through a schema library at the top of the handler and
return 400 with the offending field named before any query is issued.

## Escape hatch

Permitted when input has already been validated by middleware that runs before
this handler and attaches a typed, guaranteed-safe object to the request (e.g.
`req.validated`). Mark the bypass and name the middleware:

```js
// scar-tissue-allow: unvalidated-input-route-handler — validated by authMiddleware, see middleware/auth.js
```
