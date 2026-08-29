---
id: <kebab-case-id-describing-the-class-not-the-incident>
bug_class: <must match an id in engine/taxonomy/bug-taxonomy.json>
source_incidents: [<INC-XXX>]
confidence: <0.0 to 1.0>
created_at: <ISO 8601>
scope: ["<glob>", "<glob>"]
detection: "<regex that matches the pre-fix code and not the post-fix code>"
status: <active | needs_review | retired>
---

## Rule

<One or two imperative sentences. What is forbidden, what is required instead.
No file paths. No line numbers. No incident-specific nouns.>

## When this applies

<The conditions under which the rule is in force, and what it does not cover.>

## Why

<Two or three sentences. What happened and what it cost. Concrete.>

## Instead of this

```js
<the vulnerable pattern, reduced to its smallest generic form>
```

## Do this

```js
<the safe equivalent>
```

## Escape hatch

<When the rule may legitimately be broken and what is required to do so.>

```js
// scar-tissue-allow: <id> — <reason>
```