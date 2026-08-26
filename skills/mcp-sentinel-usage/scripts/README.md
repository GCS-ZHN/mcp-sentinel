# validate-condition.mjs

Deterministic validator for the mcp-sentinel until condition DSL. Zero
dependencies; requires node >= 18.

## Usage

```bash
node validate-condition.mjs <file.json>
echo '{"path":"status","is":"eq","value":"completed"}' | node validate-condition.mjs -
```

## Exit codes

| Code | Meaning                                      |
| ---- | -------------------------------------------- |
| 0    | Structurally valid (prints "ok")             |
| 1    | Invalid — one or more Error: lines on stderr |
| 2    | Wrong usage (no file argument)               |

## What it enforces

- The input parses as JSON and is an object.
- Exactly one condition form per object: leaf { path?, is, value }, or a
  single compound key (not | and | or).
- No unknown keys (typo'd fields are caught here, not at poll time).
- is is one of: eq, ne, gt, gte, lt, lte, contains, match.
- Leaf conditions include value; path, when present, is a string with valid
  bracket syntax ([0]-style digit groups only).
- not wraps exactly one valid condition; and / or hold non-empty arrays of
  valid conditions (recursively).

## What it cannot check

Resolvability against a live poll result — a syntactically valid path may
still name a key the tool never returns. That surfaces as the task's error
status at poll time; debug with mcp_sentinel_read.
