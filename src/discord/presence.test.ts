/**
 * Unit tests for the Discord activity builder (`docs/DISCORD-RPC.md` §4).
 */
import { describe, expect, test } from "bun:test";
import type { PresenceModel } from "../types";
import { ACTIVITY_TEXT_MAX, type ActivityType, buildActivity, validateActivity } from "./presence";

/** Reusable baseline presence model. */
const baseModel: PresenceModel = {
  details: "Working with claude",
  state: "$0.0010 · 1.0k tokens",
  startTimestamp: 1_726_060_800,
  largeImageKey: "opencode",
  largeImageText: "opencode",
  smallImageKey: "editing",
  smallImageText: "Editing",
};

describe("buildActivity", () => {
  test("maps a presence model to the Discord activity shape", () => {
    expect(buildActivity(baseModel)).toEqual({
      type: 0,
      details: "Working with claude",
      state: "$0.0010 · 1.0k tokens",
      timestamps: { start: 1_726_060_800 },
      assets: {
        large_image: "opencode",
        large_text: "opencode",
        small_image: "editing",
        small_text: "Editing",
      },
    });
  });

  test("maps null to null so callers can clear the card", () => {
    expect(buildActivity(null)).toBeNull();
  });

  test("caps text fields at 128 characters", () => {
    const activity = buildActivity({ ...baseModel, details: "x".repeat(200) });

    expect(activity?.details?.length).toBe(ACTIVITY_TEXT_MAX);
  });

  test("clamps buttons to the maximum of two", () => {
    const activity = buildActivity(baseModel, {
      buttons: [
        { label: "A", url: "https://example.com/a" },
        { label: "B", url: "https://example.com/b" },
        { label: "C", url: "https://example.com/c" },
      ],
    });

    expect(activity?.buttons).toHaveLength(2);
  });

  test("passes through a validated party block", () => {
    const activity = buildActivity(baseModel, { party: { id: "p1", size: [1, 4] } });

    expect(activity?.party).toEqual({ id: "p1", size: [1, 4] });
  });
});

describe("validateActivity", () => {
  test("accepts the RPC activity type subset", () => {
    expect(() => validateActivity({ type: 2 })).not.toThrow();
  });

  test("rejects unsupported activity types", () => {
    const unsupported = 1 as unknown as ActivityType;

    expect(() => validateActivity({ type: unsupported })).toThrow(RangeError);
  });

  test("rejects more than two buttons", () => {
    expect(() =>
      validateActivity({
        type: 0,
        buttons: [
          { label: "A", url: "https://example.com/a" },
          { label: "B", url: "https://example.com/b" },
          { label: "C", url: "https://example.com/c" },
        ],
      }),
    ).toThrow(RangeError);
  });

  test("rejects non-https button urls", () => {
    expect(() =>
      validateActivity({ type: 0, buttons: [{ label: "A", url: "http://example.com" }] }),
    ).toThrow(RangeError);
  });
});
