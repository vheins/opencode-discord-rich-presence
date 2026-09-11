/**
 * Config schema tests — option count, new presence options, enums and clamps.
 */
import { describe, expect, test } from "bun:test";
import { getDefaultConfig, validateConfig } from "./schema";

/** Count leaf options, treating arrays and scalars as single leaves. */
function countLeafOptions(value: unknown): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return 1;
  }
  return Object.values(value).reduce<number>((total, child) => total + countLeafOptions(child), 0);
}

describe("config schema", () => {
  test("exposes exactly 45 documented leaf options", () => {
    expect(countLeafOptions(getDefaultConfig())).toBe(45);
  });

  test("provides defaults for the presence-engine options", () => {
    const config = getDefaultConfig();
    expect(config.activityType).toBe("playing");
    expect(config.activityName).toBeUndefined();
    expect(config.phrases).toEqual({
      details: [],
      state: [],
      mode: "random",
      rotateMs: 0,
      cooldownMs: 5_000,
    });
    expect(config.presence).toEqual({
      showTodo: true,
      showContext: true,
      showSessionTitle: true,
      showMcpProvider: true,
    });
  });

  test("accepts every valid activity type", () => {
    for (const activityType of ["playing", "listening", "watching", "competing"] as const) {
      const result = validateConfig({ activityType });
      expect(result.warnings).toHaveLength(0);
      expect(result.config.activityType).toBe(activityType);
    }
  });

  test("rejects an unknown activity type and falls back to playing", () => {
    const result = validateConfig({ activityType: "streaming" });
    expect(result.config.activityType).toBe("playing");
    expect(result.warnings.some((warning) => warning.startsWith("activityType:"))).toBe(true);
  });

  test("rejects an unknown phrase mode and falls back to random", () => {
    const result = validateConfig({ phrases: { mode: "shuffle" } });
    expect(result.config.phrases.mode).toBe("random");
    expect(result.warnings.some((warning) => warning.startsWith("phrases:"))).toBe(true);
  });

  test("clamps rotateMs into 5000..3600000 and keeps 0 disabled", () => {
    expect(validateConfig({ phrases: { rotateMs: 1_000 } }).config.phrases.rotateMs).toBe(5_000);
    expect(validateConfig({ phrases: { rotateMs: 9_999_999 } }).config.phrases.rotateMs).toBe(
      3_600_000,
    );
    expect(validateConfig({ phrases: { rotateMs: 30_000 } }).config.phrases.rotateMs).toBe(30_000);
    expect(validateConfig({ phrases: { rotateMs: 0 } }).config.phrases.rotateMs).toBe(0);
    expect(validateConfig({ phrases: { rotateMs: -50 } }).config.phrases.rotateMs).toBe(0);
  });

  test("validates phrase arrays and activity name bounds", () => {
    const result = validateConfig({
      activityName: "Spotify",
      phrases: { details: ["{project}"], state: ["Deep focus"] },
    });
    expect(result.config.activityName).toBe("Spotify");
    expect(result.config.phrases.details).toEqual(["{project}"]);
    expect(result.config.phrases.state).toEqual(["Deep focus"]);

    const invalid = validateConfig({ activityName: "" });
    expect(invalid.config.activityName).toBeUndefined();
    expect(invalid.warnings.some((warning) => warning.startsWith("activityName:"))).toBe(true);
  });
});
