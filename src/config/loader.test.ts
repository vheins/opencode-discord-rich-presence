/**
 * Config loader tests — environment wiring for the presence-engine options.
 */
import { describe, expect, test } from "bun:test";
import { createConfigLoader } from "./loader";

/** Build a loader isolated from the host filesystem. */
function loaderWith(env: Record<string, string | undefined>) {
  return createConfigLoader({
    env,
    homeDir: "/nonexistent-opencode-discord-home",
    readFile: async () => null,
  });
}

describe("config loader env overrides", () => {
  test("reads activity type, activity name and rotation interval", async () => {
    const config = await loaderWith({
      OPENCODE_DISCORD_ACTIVITY_TYPE: "listening",
      OPENCODE_DISCORD_ACTIVITY_NAME: "Spotify",
      OPENCODE_DISCORD_ROTATE_MS: "30000",
    }).load("/tmp/opencode-discord-loader-test");

    expect(config.activityType).toBe("listening");
    expect(config.activityName).toBe("Spotify");
    expect(config.phrases.rotateMs).toBe(30_000);
  });

  test("clamps OPENCODE_DISCORD_ROTATE_MS below the minimum", async () => {
    const config = await loaderWith({ OPENCODE_DISCORD_ROTATE_MS: "1000" }).load(
      "/tmp/opencode-discord-loader-test",
    );
    expect(config.phrases.rotateMs).toBe(5_000);
  });

  test("ignores an invalid OPENCODE_DISCORD_ACTIVITY_TYPE", async () => {
    const warnings: string[] = [];
    const loader = createConfigLoader({
      env: { OPENCODE_DISCORD_ACTIVITY_TYPE: "streaming" },
      homeDir: "/nonexistent-opencode-discord-home",
      readFile: async () => null,
      onWarning: (message) => warnings.push(message),
    });
    const config = await loader.load("/tmp/opencode-discord-loader-test");
    expect(config.activityType).toBe("playing");
    expect(warnings.some((warning) => warning.startsWith("activityType:"))).toBe(true);
  });
});
