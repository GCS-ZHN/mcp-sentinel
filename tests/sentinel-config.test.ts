import { describe, it, expect } from "bun:test";
import { getMaxPollLog, getTaskTtlMs } from "../src/services/sentinel-config.js";

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const old = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    if (old === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = old;
    }
  }
}

describe("sentinel-config", () => {
  describe("getMaxPollLog", () => {
    it("returns undefined when not set", () => {
      withEnv("SENTINEL_MAX_POLL_LOG", undefined, () => {
        expect(getMaxPollLog()).toBeUndefined();
      });
    });

    it("returns the number when set to a positive integer", () => {
      withEnv("SENTINEL_MAX_POLL_LOG", "100", () => {
        expect(getMaxPollLog()).toBe(100);
      });
    });

    it("returns undefined when set to 0", () => {
      withEnv("SENTINEL_MAX_POLL_LOG", "0", () => {
        expect(getMaxPollLog()).toBeUndefined();
      });
    });

    it("returns undefined when set to a negative number", () => {
      withEnv("SENTINEL_MAX_POLL_LOG", "-5", () => {
        expect(getMaxPollLog()).toBeUndefined();
      });
    });

    it("returns undefined when set to a non-numeric string", () => {
      withEnv("SENTINEL_MAX_POLL_LOG", "abc", () => {
        expect(getMaxPollLog()).toBeUndefined();
      });
    });
  });

  describe("getTaskTtlMs", () => {
    it("returns undefined when not set", () => {
      withEnv("SENTINEL_TASK_TTL_MS", undefined, () => {
        expect(getTaskTtlMs()).toBeUndefined();
      });
    });

    it("returns the number when set to a positive integer", () => {
      withEnv("SENTINEL_TASK_TTL_MS", "5000", () => {
        expect(getTaskTtlMs()).toBe(5000);
      });
    });

    it("returns undefined when set to 0", () => {
      withEnv("SENTINEL_TASK_TTL_MS", "0", () => {
        expect(getTaskTtlMs()).toBeUndefined();
      });
    });

    it("returns undefined when set to a negative number", () => {
      withEnv("SENTINEL_TASK_TTL_MS", "-100", () => {
        expect(getTaskTtlMs()).toBeUndefined();
      });
    });

    it("returns undefined when set to a non-numeric string", () => {
      withEnv("SENTINEL_TASK_TTL_MS", "xyz", () => {
        expect(getTaskTtlMs()).toBeUndefined();
      });
    });
  });
});
