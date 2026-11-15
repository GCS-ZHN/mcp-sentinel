import { afterEach, describe, expect, it } from "bun:test";
import type { SentinelTask } from "@gcszhn/mcp-sentinel-core";
import {
  claimSession,
  dispatchNotification,
  getActiveHostBinding,
  getCombinedMcpConfigs,
  getHostBindingCount,
  registerHostBinding,
  unregisterHostBinding,
} from "../src/host-registry.js";
import type { HostBinding } from "../src/host-registry.js";

const registered: HostBinding[] = [];

function makeBinding(label: string, calls: string[]): HostBinding {
  return {
    notifier: async () => {
      calls.push(label);
    },
    logSink: () => {},
  };
}

function register(binding: HostBinding): HostBinding {
  registerHostBinding(binding);
  registered.push(binding);
  return binding;
}

function makeTask(sessionID?: string): SentinelTask {
  return {
    id: "sentinel_1",
    request: {
      server: "srv",
      tool: "tool",
      args: {},
      until: { path: "status", is: "eq", value: "completed" },
      sessionID,
    },
    createdAt: 1000,
    pollCount: 1,
    lastResult: { status: "running" },
    pollLog: [],
    status: "polling",
  };
}

afterEach(() => {
  while (registered.length > 0) {
    const binding = registered.pop();
    if (binding) unregisterHostBinding(binding);
  }
});

describe("host binding registry", () => {
  it("routes a notification to the session's owner", async () => {
    const calls: string[] = [];
    const first = register(makeBinding("first", calls));
    register(makeBinding("second", calls));
    claimSession("ses-1", first);

    await dispatchNotification(makeTask("ses-1"), "completed");

    expect(calls).toEqual(["first"]);
  });

  it("falls back to the most recently registered binding without an owner", async () => {
    const calls: string[] = [];
    register(makeBinding("first", calls));
    register(makeBinding("second", calls));

    await dispatchNotification(makeTask("unknown-session"), "completed");

    expect(calls).toEqual(["second"]);
  });

  it("falls back to the active binding when the owner unloads", async () => {
    const calls: string[] = [];
    const first = register(makeBinding("first", calls));
    register(makeBinding("second", calls));
    claimSession("ses-1", first);

    unregisterHostBinding(first);
    await dispatchNotification(makeTask("ses-1"), "completed");

    expect(calls).toEqual(["second"]);
  });

  it("is idempotent when the same binding is registered twice", () => {
    const binding = register(makeBinding("only", []));
    registerHostBinding(binding);
    expect(getHostBindingCount()).toBe(1);
    expect(getActiveHostBinding()).toBe(binding);
  });

  it("clears the active binding when the last instance unloads", async () => {
    const calls: string[] = [];
    const binding = register(makeBinding("only", calls));

    unregisterHostBinding(binding);
    expect(getHostBindingCount()).toBe(0);
    expect(getActiveHostBinding()).toBeUndefined();

    await dispatchNotification(makeTask("ses-1"), "completed");
    expect(calls).toEqual([]);
  });

  it("merges every live instance's MCP config into the reconciliation view", () => {
    const first = register(makeBinding("first", []));
    first.mcpConfig = {
      servers: {
        shared: { type: "remote", url: "http://first/mcp" },
        alpha: { type: "remote", url: "http://a/mcp" },
      },
    };

    const second = register(makeBinding("second", []));
    second.mcpConfig = {
      servers: {
        shared: { type: "remote", url: "http://second/mcp" },
        beta: { type: "remote", url: "http://b/mcp" },
      },
    };

    // Same server name with different configs in two locations: both survive,
    // because the core keys connections by full config identity.
    expect(getCombinedMcpConfigs()).toEqual([
      {
        servers: {
          shared: { type: "remote", url: "http://first/mcp" },
          alpha: { type: "remote", url: "http://a/mcp" },
        },
      },
      {
        servers: {
          shared: { type: "remote", url: "http://second/mcp" },
          beta: { type: "remote", url: "http://b/mcp" },
        },
      },
    ]);

    unregisterHostBinding(second);
    expect(getCombinedMcpConfigs()).toEqual([
      {
        servers: {
          shared: { type: "remote", url: "http://first/mcp" },
          alpha: { type: "remote", url: "http://a/mcp" },
        },
      },
    ]);
  });
});
