export type ComparisonOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains" | "match";

export interface SimpleCondition {
  path: string;
  is: ComparisonOp;
  value: unknown;
}

export interface NotCondition {
  not: SentinelCondition;
}

export interface AndCondition {
  and: SentinelCondition[];
}

export interface OrCondition {
  or: SentinelCondition[];
}

export type SentinelCondition = SimpleCondition | NotCondition | AndCondition | OrCondition;

export interface SentinelRequest {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  interval?: number;
  timeout?: number;
  until: SentinelCondition;
  sessionID: string;
}

export interface SentinelTask {
  id: string;
  request: SentinelRequest;
  createdAt: number;
  pollCount: number;
  lastResult: unknown;
  pollLog: Array<{ index: number; time: number; result: unknown }>;
  status: "polling" | "completed" | "cancelled" | "timeout" | "error";
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
