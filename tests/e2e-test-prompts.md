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

## 16. Session expiry recovery (requires remote mock-ci server)

### Setup

```bash
# Start the HTTP mock server in background (session expires after 3 tool calls)
pty_spawn command=bun args=["run","tests/mock-mcp-server.ts","--transport=http"] notifyOnExit=true
```

Add to `.opencode/opencode.jsonc`:

```jsonc
"mcp": {
  "mock-ci": {
    "type": "local",
    "command": ["bun", "run", "{env:PWD}/tests/mock-mcp-server.ts"],
    "enabled": true
  },
  "mock-ci-http": {
    "type": "remote",
    "url": "http://localhost:19879/mcp",
    "enabled": true
  }
}
```

Then run:

```
Use mcp_sentinel_poll server=mock-ci-http tool=get_job_status args={"job_id":"e2e-expiry"} interval=1000 until={"path":"status","is":"eq","value":"completed"} timeout=60000. The session will expire after 3 tool calls causing a 404 error — the sentinel MUST reconnect and continue polling until the job completes.
```

Expected: sentinel completes with status=completed, not error. Poll count > 3 (survived session expiry).

## 17. MCP server temporary network failure (connection refused / timeout)

```
Start a mock HTTP server, submit a job, start a sentinel. Then kill the HTTP server briefly and restart it. The sentinel should survive and eventually complete.

Steps:
1. Start mock-ci-http server
2. Use mcp_sentinel_poll server=mock-ci-http tool=get_job_status args={"job_id":"e2e-reconnect"} interval=1000 until={"path":"status","is":"eq","value":"completed"} timeout=120000
3. Kill the HTTP server process for 3-5 seconds
4. Restart the HTTP server
5. Wait for sentinel to complete
```

Expected: sentinel recovers after server comes back, completes successfully. No "error" status.

## 18. Non-existent MCP tool on remote server (error passthrough)

```
Use mcp_sentinel_poll server=mock-ci-http tool=nonexistent args={"job_id":"e2e-err"} interval=2000 timeout=10000 until={"path":"x","is":"eq","value":"y"}.
```

Expected: raw MCP error `-32602: Tool nonexistent not found` passed through verbatim.

## 19. Plugin-level reconnection unit verification

In addition to the integration test, the following unit test guarantees are verified:

1. `isConnectionError` detects: 404, "Session not found", "Not connected", ECONNREFUSED, ECONNRESET, ETIMEDOUT, "fetch failed", 5xx
2. `isConnectionError` does NOT detect: 403, 401, "Tool not found", null, undefined
3. `callTool` reconnects on session expiry (404) and returns valid result
4. Subsequent tool calls use the newly cached (healthy) connection
5. Dead clients are evicted from connection cache on connection error
