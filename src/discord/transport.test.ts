/**
 * Unit tests for Discord frame encoding/decoding (`docs/DISCORD-RPC.md` §3).
 */
import { describe, expect, test } from "bun:test";
import { createFrameDecoder, encodeFrame, MAX_FRAME_SIZE, OPCODES } from "./transport";

/** Captured frame emitted by the decoder under test. */
type CapturedFrame = { op: number; payload: unknown };

describe("encodeFrame", () => {
  test("writes a little-endian opcode and length followed by UTF-8 JSON", () => {
    const payload = { cmd: "SET_ACTIVITY", nonce: "n1" };
    const frame = encodeFrame(OPCODES.FRAME, payload);
    const body = Buffer.from(JSON.stringify(payload), "utf8");

    expect(frame.readUInt32LE(0)).toBe(OPCODES.FRAME);
    expect(frame.readUInt32LE(4)).toBe(body.length);
    expect(frame.length).toBe(8 + body.length);
    expect(frame.subarray(8).toString("utf8")).toBe(JSON.stringify(payload));
  });

  test("encodes the documented opcode-0 handshake shape", () => {
    const frame = encodeFrame(OPCODES.HANDSHAKE, { v: 1, client_id: "123" });

    expect(frame.readUInt32LE(0)).toBe(0);
    expect(JSON.parse(frame.subarray(8).toString("utf8"))).toEqual({ v: 1, client_id: "123" });
  });

  test("rejects payloads larger than 64 KiB", () => {
    const oversized = { data: "x".repeat(MAX_FRAME_SIZE) };

    expect(() => encodeFrame(OPCODES.FRAME, oversized)).toThrow(RangeError);
  });
});

describe("createFrameDecoder", () => {
  test("decodes a single complete frame", () => {
    const frames: CapturedFrame[] = [];
    const decoder = createFrameDecoder();

    decoder.push(encodeFrame(OPCODES.FRAME, { evt: "READY" }), (op, payload) => {
      frames.push({ op, payload });
    });

    expect(frames).toEqual([{ op: OPCODES.FRAME, payload: { evt: "READY" } }]);
  });

  test("retains partial headers and decodes coalesced frames in order", () => {
    const frames: CapturedFrame[] = [];
    const onFrame = (op: number, payload: unknown): void => {
      frames.push({ op, payload });
    };
    const decoder = createFrameDecoder();
    const first = encodeFrame(OPCODES.FRAME, { n: 1 });
    const second = encodeFrame(OPCODES.FRAME, { n: 2 });
    const combined = Buffer.concat([first, second]);

    decoder.push(combined.subarray(0, 5), onFrame);
    expect(frames).toEqual([]);

    decoder.push(combined.subarray(5, first.length + 3), onFrame);
    expect(frames).toEqual([{ op: OPCODES.FRAME, payload: { n: 1 } }]);

    decoder.push(combined.subarray(first.length + 3), onFrame);
    expect(frames).toEqual([
      { op: OPCODES.FRAME, payload: { n: 1 } },
      { op: OPCODES.FRAME, payload: { n: 2 } },
    ]);
  });

  test("rejects a declared length larger than 64 KiB", () => {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(OPCODES.FRAME, 0);
    header.writeUInt32LE(MAX_FRAME_SIZE + 1, 4);
    const decoder = createFrameDecoder();

    expect(() => decoder.push(header, () => undefined)).toThrow(RangeError);
  });
});
