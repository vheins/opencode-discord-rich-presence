/**
 * Unit tests for reconnect backoff scheduling (`docs/DISCORD-RPC.md` §7.2).
 */
import { describe, expect, test } from "bun:test";
import { backoffSchedule, DEFAULT_BACKOFF, nextDelay, resolveBackoff } from "./reconnect";

describe("resolveBackoff", () => {
  test("applies the documented defaults", () => {
    expect(resolveBackoff()).toEqual(DEFAULT_BACKOFF);
  });

  test("overrides only the provided fields", () => {
    expect(resolveBackoff({ baseMs: 500, maxAttempts: 3 })).toEqual({
      baseMs: 500,
      capMs: 30_000,
      maxAttempts: 3,
      jitterRatio: 0.2,
      minDelayMs: 250,
    });
  });
});

describe("nextDelay", () => {
  test("grows exponentially from the base with zero jitter", () => {
    expect(nextDelay(0, { random: () => 0.5 })).toBe(1_000);
    expect(nextDelay(1, { random: () => 0.5 })).toBe(2_000);
    expect(nextDelay(2, { random: () => 0.5 })).toBe(4_000);
  });

  test("caps the exponential term and bounds jitter", () => {
    expect(nextDelay(20, { random: () => 1 })).toBe(Math.round(30_000 * 1.2));
    expect(nextDelay(20, { random: () => 0 })).toBe(Math.round(30_000 * 0.8));
  });

  test("never returns a delay below the configured floor", () => {
    expect(nextDelay(0, { baseMs: 100, minDelayMs: 250, random: () => 0 })).toBe(250);
  });

  test("keeps random jitter within ±20% of the exponential term", () => {
    for (let index = 0; index < 200; index += 1) {
      const delay = nextDelay(0);
      expect(delay).toBeGreaterThanOrEqual(800);
      expect(delay).toBeLessThanOrEqual(1_200);
    }
  });
});

describe("backoffSchedule", () => {
  test("produces one entry per allowed attempt, ending at the cap", () => {
    const schedule = backoffSchedule({ random: () => 0.5 });

    expect(schedule).toHaveLength(10);
    expect(schedule[0]).toBe(1_000);
    expect(schedule[1]).toBe(2_000);
    expect(schedule[9]).toBe(30_000);
  });

  test("returns an empty schedule when no attempts are allowed", () => {
    expect(backoffSchedule({ maxAttempts: 0 })).toEqual([]);
  });
});
