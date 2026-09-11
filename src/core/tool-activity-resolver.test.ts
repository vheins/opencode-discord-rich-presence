/**
 * Tool activity resolver tests — built-ins, generic MCP parsing and phrase gating.
 */
import { describe, expect, test } from "bun:test";
import { createToolActivityResolver, MCP_FALLBACK_PHRASE } from "./tool-activity-resolver";

describe("tool activity resolver", () => {
  test("resolves built-in file tools with a reading phrase", () => {
    const resolver = createToolActivityResolver({ mode: "random", cooldownMs: 0, random: () => 0 });
    const activity = resolver.resolve({ tool: "read", filePath: "src/index.ts" });
    expect(activity.source).toBe("builtin");
    expect(activity.action).toBe("Reading");
    expect(activity.target).toBe("src/index.ts");
    expect(activity.phrase).toBe("Tracing the code");
  });

  test("parses known MCP tools generically", () => {
    const resolver = createToolActivityResolver({ mode: "sequential", cooldownMs: 0 });
    const activity = resolver.resolve({ tool: "mcp__github__search_code" });
    expect(activity.source).toBe("mcp");
    expect(activity.provider).toBe("GitHub");
    expect(activity.action).toBe("Searching repository");
    expect(activity.phrase).toBe("Connecting external systems");
  });

  test("falls back for unknown MCP tools and providers without code changes", () => {
    const resolver = createToolActivityResolver({ mode: "random", cooldownMs: 0, random: () => 0 });

    // Unknown tool -> generic action + fixed fallback phrase.
    const unknownTool = resolver.resolve({ tool: "mcp__acme__frobnicate" });
    expect(unknownTool.source).toBe("mcp");
    expect(unknownTool.provider).toBe("MCP");
    expect(unknownTool.action).toBe("Running frobnicate");
    expect(unknownTool.phrase).toBe(MCP_FALLBACK_PHRASE);

    // Known tool + unknown provider -> generic title-cased provider label.
    const unknownProvider = resolver.resolve({ tool: "mcp__acme__search_code" });
    expect(unknownProvider.provider).toBe("Acme");
    expect(unknownProvider.action).toBe("Searching repository");
  });

  test("treats unrecognized non-MCP tools as custom", () => {
    const resolver = createToolActivityResolver({ mode: "random", cooldownMs: 0, random: () => 0 });
    const activity = resolver.resolve({ tool: "myTool" });
    expect(activity.source).toBe("custom");
    expect(activity.action).toBe("Running myTool");
    expect(activity.phrase).toBe("Shaping the code");
  });

  test("advances sequential pools on rotate and honors the cooldown", () => {
    let clock = 1_000;
    const resolver = createToolActivityResolver({
      mode: "sequential",
      cooldownMs: 5_000,
      now: () => clock,
    });

    const first = resolver.resolve({ tool: "read", filePath: "a.ts" });
    expect(first.phrase).toBe("Tracing the code");

    // A different key is isolated: it selects from its own pool instead of inheriting.
    const independent = resolver.resolve({ tool: "grep", filePath: "b.ts" });
    expect(independent.phrase).toBe("Following the trail");

    clock += 10_000;
    const second = resolver.resolve({ tool: "read", filePath: "a.ts" });
    expect(second.phrase).toBe("Reading between the lines");

    // Forced rotation bypasses the cooldown.
    const forced = resolver.rotate({ tool: "read", filePath: "a.ts" });
    expect(forced.phrase).toBe("Following the dependency trail");
  });

  test("keeps per-key phrase state isolated and cooldown-bound", () => {
    let clock = 0;
    const resolver = createToolActivityResolver({
      mode: "sequential",
      cooldownMs: 5_000,
      now: () => clock,
    });

    // `details` and `state` pools must not poison each other.
    const details = ["d1", "d2"];
    const state = ["s1", "s2"];
    expect(resolver.selectPool(details, "details")).toBe("d1");
    expect(resolver.selectPool(state, "state")).toBe("s1");

    // Same key inside the cooldown reuses the phrase...
    expect(resolver.selectPool(details, "details")).toBe("d1");

    // ...but advances once the cooldown expires instead of locking forever.
    clock += 5_000;
    expect(resolver.selectPool(details, "details")).toBe("d2");
  });

  test("suppresses command targets under privacy but keeps file targets", () => {
    const resolver = createToolActivityResolver({
      mode: "random",
      cooldownMs: 0,
      privacy: { hideFilePaths: true },
      random: () => 0,
    });

    const bash = resolver.resolve({ tool: "bash", target: "curl -H 'Authorization: secret'" });
    expect(bash.target).toBeUndefined();

    const read = resolver.resolve({ tool: "read", filePath: "src/index.ts" });
    expect(read.target).toBe("src/index.ts");
  });

  test("keeps command targets when privacy is disabled", () => {
    const resolver = createToolActivityResolver({
      mode: "random",
      cooldownMs: 0,
      privacy: { hideFilePaths: false },
      random: () => 0,
    });

    const bash = resolver.resolve({ tool: "bash", target: "pnpm test" });
    expect(bash.target).toBe("pnpm test");
  });

  test("selects config pools with cooldown-aware and forced rotation", () => {
    let clock = 0;
    const resolver = createToolActivityResolver({
      mode: "sequential",
      cooldownMs: 5_000,
      now: () => clock,
    });
    const pool = ["alpha", "beta", "gamma"];
    expect(resolver.selectPool(pool, "details")).toBe("alpha");
    expect(resolver.rotatePool(pool, "details")).toBe("beta");
    expect(resolver.rotatePool(pool, "details")).toBe("gamma");
    expect(resolver.rotatePool(pool, "details")).toBe("alpha");
    clock += 1_000;
    // Same key inside cooldown reuses the last selected phrase.
    expect(resolver.selectPool(pool, "details")).toBe("alpha");
  });
});
