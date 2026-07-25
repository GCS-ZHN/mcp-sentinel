export type ComparisonOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains" | "match";

export interface SimpleCondition {
  path: string;
  is: ComparisonOp;
  value: unknown;
}

export interface NotCondition {
  not: PollCondition;
}

export interface AndCondition {
  and: PollCondition[];
}

export interface OrCondition {
  or: PollCondition[];
}

export type PollCondition = SimpleCondition | NotCondition | AndCondition | OrCondition;

export interface PollRequest {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  interval?: number;
  timeout?: number;
  until: PollCondition;
  sessionID: string;
}

export interface PollTask {
  id: string;
  request: PollRequest;
  createdAt: number;
  pollCount: number;
  lastResult: unknown;
  status: "polling" | "completed" | "timeout" | "error";
  error?: string;
  resolvedAt?: number;
}

export interface McpLocalConfig {
  type: "local";
  command: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

export interface McpRemoteConfig {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export type McpServerConfig = McpLocalConfig | McpRemoteConfig;

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}
