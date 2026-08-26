# until condition reference

The until parameter of mcp_sentinel_poll is a JSON condition object. It is
pure declarative data — no code, no expressions, no injection surface. This
file is the complete reference; SKILL.md holds the quick rules.

## Condition forms

Every condition object is exactly ONE of these forms (mixing forms, adding
unknown keys, or omitting required fields is invalid):

| Form     | Shape                                             | Notes                                                  |
| -------- | ------------------------------------------------- | ------------------------------------------------------ |
| Leaf     | { "path": string?, "is": operator, "value": any } | path optional; omitted or "" compares the whole result |
| Negation | { "not": <condition> }                            | exactly one nested condition                           |
| And      | { "and": [ <condition>, ... ] }                   | non-empty array                                        |
| Or       | { "or": [ <condition>, ... ] }                    | non-empty array                                        |

## Operators

| Operator            | Semantics                                                                     |
| ------------------- | ----------------------------------------------------------------------------- |
| eq                  | strict equality (===)                                                         |
| ne                  | strict inequality (!==)                                                       |
| gt / gte / lt / lte | numeric comparison; both sides coerced with Number()                          |
| contains            | actual is a string containing expected (both strings)                         |
| match               | new RegExp(expected).test(String(actual)); invalid regex simply never matches |

Examples:

```json
{ "path": "status", "is": "eq", "value": "completed" }
{ "path": "tasks[0].exit_code", "is": "ne", "value": 0 }
{ "path": "duration_ms", "is": "gte", "value": 120000 }
{ "path": "log", "is": "match", "value": "^error" }
```

## Path syntax

Path is property-access notation with array indices:

```
status             -> obj.status
tasks[0].exit_code -> obj.tasks[0].exit_code
[0].data.path      -> obj[0].data.path
items[2].name      -> obj.items[2].name
```

Index groups must be bare digits ([0], [12]) attached directly to the
preceding token. Anything else (spaces inside brackets, letters in brackets)
is malformed and will not resolve — the poll fails with status error.

Resolvability (whether a key actually exists in the tool's result) can only be
proven at poll time. The validator checks syntax; the running poll checks
existence.

## Empty path and non-JSON results

- Omitting path, or passing "", compares the is/value pair against the tool's
  ENTIRE returned value (no JSON-path resolution).
- Plain-text (non-JSON) results are treated as a single string, and can only
  be compared with an empty path. Example: a tool returns the literal string
  "done" — match with { "is": "eq", "value": "done" }.
- Numbers / booleans / null results are also leaves and can be matched with an
  empty path: { "is": "eq", "value": true }.

## Leaf-only rule

The RESOLVED value (the path target, or the whole result when path is empty)
must be a leaf: string, number, boolean, or null. If it is an array or object,
the poll throws and the task surfaces status error — the agent learns the
condition is misconfigured instead of it silently never matching.

## Missing keys and indices throw

Resolving a path to a key that does not exist, an out-of-range array index, or
a property read off a null/primitive node throws immediately (surfacing as
status error). A typo'd field name must reach you, not poll forever. Example
poll results that trigger this:

- { "tasks": [ { "name": "a" } ] } with path tasks[1].name -> index 1 out of range
- { "status": null } with path status.detail -> cannot read "detail" of null
- { "state": "running" } with path statu -> key "statu" does not exist

## Compound nesting

- not wraps exactly one condition.
- and / or hold non-empty arrays of conditions, each recursively one of the
  four forms.
- All nested conditions must hold for and; any for or.

```json
{ "and": [
  { "path": "status", "is": "eq", "value": "completed" },
  { "path": "tasks[0].exit_code", "is": "eq", "value": 0 }
] }

{ "not": { "path": "error", "is": "contains", "value": "fatal" } }
```

## Validator

Validate any non-trivial condition before submitting (do not eyeball it):

```bash
node scripts/validate-condition.mjs /path/to/until.json   # prints "ok", exit 0
echo '{"or":[{"is":"eq","value":1},{"is":"eq","value":2}]}' | node scripts/validate-condition.mjs -
```

Exit 0 = structurally valid; exit 1 = invalid (specific messages on stderr);
exit 2 = wrong usage. The validator enforces: exactly one form per object,
known keys only, is in the operator set, value present for leaves, path
syntax, not/and/or shapes. It cannot verify resolvability against live results
— that is the running poll's job.

## Common mistakes

- is typo'd (equal, ==, equals) -> rejected by validator / error status.
- Comparing an object: { "path": "tasks", "is": "eq", "value": [] } -> tasks
  resolves to an array -> error status. Compare a leaf inside it instead.
- Missing value: { "path": "status", "is": "eq" } -> invalid leaf.
- String arg to until ("completed") -> rejected by the tool
  ("until must be a JSON object describing a condition.").
- Path with brackets in the middle of a token (a[0]b) -> malformed.
