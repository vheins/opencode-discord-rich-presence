/**
 * Unit tests for cross-platform IPC path discovery (`docs/DISCORD-RPC.md` §2).
 */
import { describe, expect, test } from "bun:test";
import { discoverIpcSocket, IPC_MAX_SLOT, listIpcCandidates, resolveUnixIpcDir } from "./ipc";

describe("resolveUnixIpcDir", () => {
  test("honours the documented priority chain", () => {
    expect(
      resolveUnixIpcDir({
        XDG_RUNTIME_DIR: "/run/user/1",
        TMPDIR: "/tmpdir",
        TMP: "/tmp2",
        TEMP: "/temp",
      }),
    ).toBe("/run/user/1");
    expect(resolveUnixIpcDir({ TMPDIR: "/tmpdir", TMP: "/tmp2" })).toBe("/tmpdir");
    expect(resolveUnixIpcDir({ TMP: "/tmp2", TEMP: "/temp" })).toBe("/tmp2");
    expect(resolveUnixIpcDir({ TEMP: "/temp" })).toBe("/temp");
  });

  test("falls back to /tmp and skips empty values", () => {
    expect(resolveUnixIpcDir({})).toBe("/tmp");
    expect(resolveUnixIpcDir({ XDG_RUNTIME_DIR: "", TMPDIR: "/tmpdir" })).toBe("/tmpdir");
  });
});

describe("listIpcCandidates", () => {
  test("enumerates ten Unix candidates in the resolved directory", () => {
    const candidates = listIpcCandidates({
      platform: "linux",
      env: { XDG_RUNTIME_DIR: "/run/user/1" },
    });

    expect(candidates).toHaveLength(IPC_MAX_SLOT + 1);
    expect(candidates[0]).toBe("/run/user/1/discord-ipc-0");
    expect(candidates[9]).toBe("/run/user/1/discord-ipc-9");
  });

  test("uses Windows named pipe paths on win32", () => {
    const candidates = listIpcCandidates({ platform: "win32" });

    expect(candidates[0]).toBe("\\\\?\\pipe\\discord-ipc-0");
    expect(candidates[9]).toBe("\\\\?\\pipe\\discord-ipc-9");
  });

  test("honours a custom maximum slot", () => {
    expect(listIpcCandidates({ platform: "linux", maxSlot: 2 })).toHaveLength(3);
  });
});

describe("discoverIpcSocket", () => {
  test("returns the first candidate reported as existing on Unix", () => {
    const probe = (path: string): boolean => path.endsWith("discord-ipc-2");

    expect(discoverIpcSocket({ platform: "linux", env: { TMPDIR: "/tmpdir" } }, probe)).toBe(
      "/tmpdir/discord-ipc-2",
    );
  });

  test("returns null when no Unix candidate exists", () => {
    expect(discoverIpcSocket({ platform: "linux" }, () => false)).toBeNull();
  });

  test("returns the first pipe on win32 without probing", () => {
    expect(discoverIpcSocket({ platform: "win32" }, () => false)).toBe(
      "\\\\?\\pipe\\discord-ipc-0",
    );
  });
});
