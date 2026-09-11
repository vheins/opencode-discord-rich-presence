/**
 * Transport integration tests using an injected fake socket (no real Discord IPC).
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { createTransport, encodeFrame, MAX_FRAME_SIZE, OPCODES } from "./transport";

/** Minimal in-memory socket capturing writes and emitting synthetic events. */
class FakeSocket extends EventEmitter {
  destroyed = false;
  readonly written: Buffer[] = [];

  write(chunk: Buffer): boolean {
    this.written.push(chunk);
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("close");
  }
}

/** Transport plus the sockets it created. */
interface Harness {
  transport: ReturnType<typeof createTransport>;
  sockets: FakeSocket[];
}

/** Yield to the event loop so pending microtasks settle. */
const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/** Build a transport whose socket factory returns a controllable fake. */
function createHarness(): Harness {
  const sockets: FakeSocket[] = [];
  const transport = createTransport({
    clientId: "123456789012345678",
    candidates: ["/tmp/discord-ipc-0"],
    socketFactory: () => {
      const fake = new FakeSocket();
      sockets.push(fake);
      queueMicrotask(() => {
        fake.emit("connect");
      });
      return fake as unknown as Socket;
    },
  });
  return { transport, sockets };
}

describe("createTransport handshake", () => {
  test("sends the opcode-0 handshake and resolves on READY", async () => {
    const { transport, sockets } = createHarness();
    const connecting = transport.connect();
    await tick();

    const socket = sockets[0] as FakeSocket;
    const handshake = socket.written[0] as Buffer;
    expect(handshake.readUInt32LE(0)).toBe(OPCODES.HANDSHAKE);
    expect(JSON.parse(handshake.subarray(8).toString("utf8"))).toEqual({
      v: 1,
      client_id: "123456789012345678",
    });

    socket.emit("data", encodeFrame(OPCODES.FRAME, { cmd: "DISPATCH", evt: "READY", data: {} }));
    await connecting;
    expect(transport.state).toBe("ready");
  });

  test("rejects when the socket closes before READY", async () => {
    const { transport, sockets } = createHarness();
    const connecting = transport.connect();
    await tick();

    (sockets[0] as FakeSocket).emit("close");
    await expect(connecting).rejects.toThrow("transport socket closed");
    expect(transport.state).toBe("disconnected");
  });
});

describe("createTransport decoder failure", () => {
  test("tears down the socket and emits disconnected on an oversized frame", async () => {
    const { transport, sockets } = createHarness();
    const connecting = transport.connect();
    await tick();

    const socket = sockets[0] as FakeSocket;
    socket.emit("data", encodeFrame(OPCODES.FRAME, { evt: "READY" }));
    await connecting;
    expect(transport.state).toBe("ready");

    let disconnected = false;
    transport.on("disconnected", () => {
      disconnected = true;
    });

    const header = Buffer.alloc(8);
    header.writeUInt32LE(OPCODES.FRAME, 0);
    header.writeUInt32LE(MAX_FRAME_SIZE + 1, 4);
    socket.emit("data", header);

    expect(transport.state).toBe("disconnected");
    expect(socket.destroyed).toBe(true);
    expect(disconnected).toBe(true);
  });

  test("tears down the socket on a malformed JSON payload", async () => {
    const { transport, sockets } = createHarness();
    const connecting = transport.connect();
    await tick();

    const socket = sockets[0] as FakeSocket;
    socket.emit("data", encodeFrame(OPCODES.FRAME, { evt: "READY" }));
    await connecting;

    const body = Buffer.from("{not json", "utf8");
    const header = Buffer.alloc(8);
    header.writeUInt32LE(OPCODES.FRAME, 0);
    header.writeUInt32LE(body.length, 4);
    socket.emit("data", Buffer.concat([header, body]));

    expect(transport.state).toBe("disconnected");
    expect(socket.destroyed).toBe(true);
  });
});

describe("createTransport setActivity", () => {
  test("sends SET_ACTIVITY and resolves on the matching nonce", async () => {
    const { transport, sockets } = createHarness();
    const connecting = transport.connect();
    await tick();

    const socket = sockets[0] as FakeSocket;
    socket.emit("data", encodeFrame(OPCODES.FRAME, { evt: "READY" }));
    await connecting;

    const pending = transport.setActivity({ details: "hello" }, "nonce-1");
    await tick();
    const frame = socket.written[1] as Buffer;
    expect(JSON.parse(frame.subarray(8).toString("utf8"))).toEqual({
      cmd: "SET_ACTIVITY",
      args: { pid: process.pid, activity: { details: "hello" } },
      nonce: "nonce-1",
    });

    socket.emit(
      "data",
      encodeFrame(OPCODES.FRAME, { cmd: "SET_ACTIVITY", data: {}, nonce: "nonce-1" }),
    );
    await pending;
  });

  test("rejects SET_ACTIVITY while not ready", async () => {
    const { transport } = createHarness();

    await expect(transport.setActivity({ details: "x" }, "n")).rejects.toThrow(
      "cannot send activity",
    );
  });
});
