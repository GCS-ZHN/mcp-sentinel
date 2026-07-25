# End-to-end test prompts

Run from project root:

```bash
opencode run "<prompt>" --dir . --print-logs --model opencode/deepseek-v4-flash-free
```

## 1. Plugin tools visible

```
list all mcp_sentinel tools
```

Expected: `mcp_sentinel_poll`, `mcp_sentinel_status`, `mcp_sentinel_attach`, `mcp_sentinel_read` all present.

## 2. Normal long-running task

```
Use mcp_sentinel_poll against mock-ci get_job_status (job_id='normal-test', interval=2000, until status=completed, no timeout). Then mcp_sentinel_attach and report all stages.
```

Expected: 17 polls, 32s, 8 stages all completed.

## 3. sentinel_read with range

```
Use mcp_sentinel_poll against mock-ci get_job_status (job_id='range-test', 2s, until status=completed, no timeout). After 5 polls, use mcp_sentinel_read offset=0 limit=3, then without offset, then attach and report.
```

Expected: first 3 polls shown, then last 3.

## 4. Non-existent MCP server

```
Use mcp_sentinel_poll server='fake-server', tool='get_job_status', args='{}', interval=2000, timeout=5000, until={"path":"x","is":"eq","value":"x"}. Check error with mcp_sentinel_status.
```

Expected: `Unknown MCP server: fake-server`

## 5. Empty server/tool

```
Use mcp_sentinel_poll server='', tool='get_job_status', args='{}', interval=2000, timeout=5000, until={"path":"x","is":"eq","value":"x"}. Then with server='mock-ci', tool=''. Check errors.
```

Expected: `server and tool must be non-empty strings.`

## 6. Non-object until

```
Use mcp_sentinel_poll server='mock-ci', tool='get_job_status', args='{}', until='not-an-object', timeout=5000. Check error.
```

Expected: `Invalid JSON for until parameter. Must be a valid JSON object.`

## 7. Invalid JSON args

```
Use mcp_sentinel_poll server='mock-ci', tool='get_job_status', args='not-json', timeout=5000, until={"path":"x","is":"eq","value":"x"}. Check error.
```

Expected: `Invalid JSON for args parameter.`

## 8. Non-existent MCP tool

```
Use mcp_sentinel_poll server='mock-ci', tool='nonexistent_tool', args='{}', timeout=5000, until={"path":"x","is":"eq","value":"x"}. Check error with mcp_sentinel_status and mcp_sentinel_read.
```

Expected: MCP error -32602: Tool not found

## 9. Wrong arg type (number for string)

```
Use mcp_sentinel_poll server='mock-ci', tool='get_job_status', args='{"job_id":123}', timeout=5000, until={"path":"x","is":"eq","value":"x"}. Check error.
```

Expected: MCP error -32602: expected string, received number

## 10. Missing required arg

```
Use mcp_sentinel_poll server='mock-ci', tool='get_job_status', args='{}', timeout=5000, until={"path":"x","is":"eq","value":"x"}. Check error.
```

Expected: MCP error -32602: expected string, received undefined

## 11. Unknown parameter (strict schema)

```
Use mcp_sentinel_poll server='mock-ci', tool='get_job_status', args='{"job_id":"test","extra_field":"unexpected"}', timeout=5000, until={"path":"x","is":"eq","value":"x"}. Check error.
```

Expected: MCP error -32602: unrecognized_keys, "extra_field"

## 12. submit_job missing required param

```
Use mcp_sentinel_poll server='mock-ci', tool='submit_job', args='{}', timeout=5000, until={"path":"x","is":"eq","value":"x"}. Check error.
```

Expected: MCP error -32602: expected string for "name"

## 13. timeout=0 (no timeout) + interval=0 (clamped to 1000)

```
Use mcp_sentinel_poll against mock-ci get_job_status (job_id='zero-test', interval=0, timeout=0, until status=completed). Then mcp_sentinel_attach timeout=0 and report completion.
```

Expected: interval clamped to 1000, timeout=0 treated as no limit. Job completes normally.

## 14. mcp_sentinel_status list

```
Use mcp_sentinel_poll against mock-ci get_job_status (job_id='list-test', 2s, until status=completed, no timeout). Then mcp_sentinel_status action=list.
```

Expected: lists the active sentinel.

## 15. mcp_sentinel_status cancel

```
Use mcp_sentinel_poll against mock-ci get_job_status (job_id='cancel-test', 5s, until status=completed, no timeout). Then mcp_sentinel_status action=cancel with the id. Verify status is 'cancelled' not 'completed'.
```

Expected: status=cancelled
