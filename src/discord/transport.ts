/**
 * Discord IPC transport — framing, handshake and command dispatch.
 *
 * Owns a single socket connection: scans IPC candidates, performs the opcode-0
 * handshake, decodes length-prefixed JSON frames and dispatches `SET_ACTIVITY`.
 * Consumers depend only on the `Transport` interface so the implementation stays
 * swappable (`docs/ARCHITECTURE.md` §6.1, `docs/DISCORD-RPC.md` §3).
 */
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { listIpcCandidates } from "./ipc";

/** Wire opcodes defined by the Discord RPC protocol. */
export const OPCODES = {
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4,
} as const;

/** Numeric Discord RPC opcode. */
export type Opcode = (typeof OPCODES)[keyof typeof OPCODES];

/** Maximum accepted frame payload size (64 KiB). */
export const MAX_FRAME_SIZE = 64 * 1024;

/** Transport lifecycle states shared with the reconnect FSM. */
export type TransportState = "disconnected" | "connecting" | "ready" | "degraded" | "closed";

/** Events emitted by a transport. */
export type TransportEvent = "ready" | "disconnected" | "error" | "closed";

/** Listener registered for a transport event. */
export type TransportListener = (arg?: unknown) => void;

/** Handle returned by the injected timeout scheduler. */
export type TimeoutHandle = ReturnType<typeof setTimeout>;

/** Scheduler injection point; defaults to the global `setTimeout`. */
export type SetTimeoutFn = (handler: () => void, ms: number) => TimeoutHandle;

/** Cancellation injection point; defaults to the global `clearTimeout`. */
export type ClearTimeoutFn = (handle: TimeoutHandle) => void;

/** Minimal transport contract consumed by the reconnect controller. */
export interface Transport {
  /** Current lifecycle state. */
  readonly state: TransportState;
  /** Connect to the first reachable IPC socket and complete the handshake. */
  connect(): Promise<void>;
  /** Send `SET_ACTIVITY`; a `null` activity clears the presence card. */
  setActivity(activity: Record<string, unknown> | null, nonce: string): Promise<void>;
  /** Clear the presence card (best-effort). */
  clear(): Promise<void>;
  /** Close the socket and move to `closed`. */
  close(): Promise<void>;
  /** Subscribe to an event. */
  on(event: TransportEvent, listener: TransportListener): void;
  /** Unsubscribe from an event. */
  off(event: TransportEvent, listener: TransportListener): void;
}

/** Per-connection frame decoder contract. */
export interface FrameDecoder {
  /** Feed a chunk and invoke `onFrame` once per complete frame. */
  push(chunk: Buffer, onFrame: (opcode: number, payload: unknown) => void): void;
}

/** Socket factory injection point; defaults to `net.createConnection`. */
export type SocketFactory = (path: string) => Socket;

/** Construction options for `createTransport`. */
export interface TransportOptions {
  /** Discord application id sent in the opcode-0 handshake. */
  clientId: string;
  /** Candidate socket paths; defaults to `listIpcCandidates()`. */
  candidates?: string[];
  /** Socket factory, injectable for tests. */
  socketFactory?: SocketFactory;
  /** Handshake timeout in ms; defaults to 10000. */
  handshakeTimeoutMs?: number;
  /** Per-request nonce timeout in ms; defaults to 10000. */
  requestTimeoutMs?: number;
  /** Process id reported in `SET_ACTIVITY`; defaults to `process.pid`. */
  pid?: number;
  /** Timeout scheduler injection point. */
  setTimeoutFn?: SetTimeoutFn;
  /** Timeout cancellation injection point. */
  clearTimeoutFn?: ClearTimeoutFn;
}

/** A pending `SET_ACTIVITY` response keyed by nonce. */
interface PendingRequest {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: TimeoutHandle;
}

/** Pending handshake completion. */
interface ReadyWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: TimeoutHandle;
}

/**
 * Release a timeout handle without keeping the process alive.
 *
 * @param handle Handle returned by the injected scheduler.
 */
export function unrefTimer(handle: TimeoutHandle): void {
  const maybe = handle as { unref?: () => void };
  maybe.unref?.();
}

/** Normalise an unknown thrown value into an `Error`. */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Narrow an unknown frame payload to a JSON object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Encode a Discord RPC frame as `LE u32 opcode + LE u32 length + UTF-8 JSON`.
 *
 * @param opcode Frame opcode.
 * @param payload JSON-serialisable payload.
 * @returns The complete frame buffer.
 * @throws RangeError When the encoded payload exceeds `MAX_FRAME_SIZE`.
 */
export function encodeFrame(opcode: number, payload: unknown): Buffer {
  const json = JSON.stringify(payload);
  const body = Buffer.from(json, "utf8");
  if (body.length > MAX_FRAME_SIZE) {
    throw new RangeError(`frame payload ${body.length} exceeds ${MAX_FRAME_SIZE} bytes`);
  }
  const header = Buffer.allocUnsafe(8);
  header.writeUInt32LE(opcode, 0);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** Stateful decoder that loops over coalesced frames and retains partial ones. */
class FrameDecoderImpl implements FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer, onFrame: (opcode: number, payload: unknown) => void): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const opcode = this.buffer.readUInt32LE(0);
      const length = this.buffer.readUInt32LE(4);
      if (length > MAX_FRAME_SIZE) {
        throw new RangeError(`frame length ${length} exceeds ${MAX_FRAME_SIZE} bytes`);
      }
      if (this.buffer.length < 8 + length) {
        break;
      }
      const json = this.buffer.subarray(8, 8 + length).toString("utf8");
      this.buffer = this.buffer.subarray(8 + length);
      onFrame(opcode, JSON.parse(json));
    }
  }
}

/**
 * Create a per-connection frame decoder.
 *
 * @returns A fresh decoder with an empty buffer.
 */
export function createFrameDecoder(): FrameDecoder {
  return new FrameDecoderImpl();
}

/**
 * Create a Discord IPC transport backed by a `net.Socket`.
 *
 * @param options Handshake identity, discovery and injection points.
 * @returns A `Transport` that owns exactly one connection at a time.
 */
export function createTransport(options: TransportOptions): Transport {
  const clientId = options.clientId;
  const candidates = options.candidates ?? listIpcCandidates();
  const socketFactory = options.socketFactory ?? ((path: string) => createConnection(path));
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const pid = options.pid ?? process.pid;
  const scheduleTimeout = options.setTimeoutFn ?? setTimeout;
  const cancelTimeout = options.clearTimeoutFn ?? clearTimeout;

  const listeners = new Map<TransportEvent, Set<TransportListener>>();
  const pending = new Map<string, PendingRequest>();
  let state: TransportState = "disconnected";
  let socket: Socket | null = null;
  let decoder: FrameDecoder = createFrameDecoder();
  let readyWaiter: ReadyWaiter | null = null;
  let disposed = false;
  let errorEmitted = false;

  /** Emit an event to every subscriber, isolating listener failures. */
  function emit(event: TransportEvent, arg?: unknown): void {
    const subscribers = listeners.get(event);
    if (subscribers === undefined) {
      return;
    }
    for (const listener of [...subscribers]) {
      try {
        listener(arg);
      } catch {
        // Listener failures must never break the transport.
      }
    }
  }

  /** Reject every pending request and clear the table. */
  function failPending(error: Error): void {
    for (const entry of pending.values()) {
      cancelTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  /** Destroy the current socket and release decoder/handshake state. */
  function teardown(): void {
    if (socket !== null) {
      socket.removeAllListeners();
      socket.destroy();
      socket = null;
    }
    decoder = createFrameDecoder();
    failPending(new Error("transport torn down"));
    if (readyWaiter !== null) {
      cancelTimeout(readyWaiter.timer);
      readyWaiter.reject(new Error("transport torn down"));
      readyWaiter = null;
    }
  }

  /** Write one frame or throw when the socket is unavailable. */
  function writeFrame(opcode: number, payload: unknown): void {
    if (socket === null || socket.destroyed) {
      throw new Error("transport socket is not open");
    }
    socket.write(encodeFrame(opcode, payload));
  }

  /** Handle an inbound frame from the server. */
  function handleFrame(opcode: number, payload: unknown): void {
    if (opcode === OPCODES.CLOSE) {
      setState("closed");
      emit("closed", payload);
      teardown();
      return;
    }
    if (opcode === OPCODES.PING) {
      writeFrame(OPCODES.PONG, payload);
      return;
    }
    if (opcode !== OPCODES.FRAME) {
      return;
    }
    const message = asRecord(payload);
    if (message === null) {
      return;
    }
    if (message.evt === "READY") {
      if (readyWaiter !== null) {
        cancelTimeout(readyWaiter.timer);
        readyWaiter.resolve();
        readyWaiter = null;
      }
      setState("ready");
      emit("ready", payload);
      return;
    }
    const nonce = message.nonce;
    if (typeof nonce !== "string") {
      return;
    }
    const entry = pending.get(nonce);
    if (entry === undefined) {
      return;
    }
    pending.delete(nonce);
    cancelTimeout(entry.timer);
    if (message.evt === "ERROR") {
      entry.reject(new Error(`SET_ACTIVITY failed: ${JSON.stringify(message.data ?? message)}`));
    } else {
      entry.resolve();
    }
  }

  /** Move to a new lifecycle state. */
  function setState(next: TransportState): void {
    state = next;
  }

  /** React to a socket-level error. */
  function handleTransportError(error: Error): void {
    if (state === "closed") {
      return;
    }
    if (state === "connecting") {
      setState("disconnected");
      emit("error", error);
      errorEmitted = true;
      teardown();
      return;
    }
    setState("degraded");
    emit("error", error);
  }

  /**
   * React to a frame-decoder failure by tearing the socket down.
   *
   * Without this the transport would stay `degraded` with a live socket, so no `close`
   * fires and the reconnect controller never retries (silent hang).
   *
   * @param error Decode failure raised by the frame decoder.
   */
  function handleDecodeError(error: Error): void {
    if (state === "closed") {
      return;
    }
    errorEmitted = true;
    emit("error", error);
    teardown();
    setState("disconnected");
    emit("disconnected");
  }

  /** React to the socket closing for any reason. */
  function handleSocketClose(): void {
    if (state === "closed") {
      return;
    }
    setState("disconnected");
    if (readyWaiter !== null) {
      cancelTimeout(readyWaiter.timer);
      readyWaiter.reject(new Error("transport socket closed"));
      readyWaiter = null;
    }
    failPending(new Error("transport socket closed"));
    emit("disconnected");
  }

  /** Attach persistent listeners to a connected socket. */
  function attachSocket(active: Socket): void {
    active.on("data", (chunk: Buffer) => {
      try {
        decoder.push(chunk, handleFrame);
      } catch (error) {
        handleDecodeError(toError(error));
      }
    });
    active.on("error", (error: Error) => {
      handleTransportError(error);
    });
    active.on("close", () => {
      handleSocketClose();
    });
  }

  /** Open a single socket, resolving on `connect`. */
  function openSocket(path: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const candidate = socketFactory(path);
      const onConnect = (): void => {
        candidate.removeListener("error", onError);
        resolve(candidate);
      };
      const onError = (error: Error): void => {
        candidate.removeListener("connect", onConnect);
        candidate.destroy();
        reject(error);
      };
      candidate.once("connect", onConnect);
      candidate.once("error", onError);
    });
  }

  /** Send one `SET_ACTIVITY` command and await its nonce response. */
  function setActivity(activity: Record<string, unknown> | null, nonce: string): Promise<void> {
    if (state !== "ready") {
      return Promise.reject(new Error(`cannot send activity in state "${state}"`));
    }
    return new Promise((resolve, reject) => {
      const timer = scheduleTimeout(() => {
        pending.delete(nonce);
        reject(new Error(`SET_ACTIVITY timed out after ${requestTimeoutMs} ms`));
      }, requestTimeoutMs);
      unrefTimer(timer);
      pending.set(nonce, { resolve, reject, timer });
      try {
        writeFrame(OPCODES.FRAME, { cmd: "SET_ACTIVITY", args: { pid, activity }, nonce });
      } catch (error) {
        pending.delete(nonce);
        cancelTimeout(timer);
        reject(toError(error));
      }
    });
  }

  /** Send the opcode-0 handshake and await `READY`. */
  function handshake(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = scheduleTimeout(() => {
        readyWaiter = null;
        reject(new Error(`handshake timed out after ${handshakeTimeoutMs} ms`));
      }, handshakeTimeoutMs);
      unrefTimer(timer);
      readyWaiter = { resolve, reject, timer };
      try {
        writeFrame(OPCODES.HANDSHAKE, { v: 1, client_id: clientId });
      } catch (error) {
        cancelTimeout(timer);
        readyWaiter = null;
        reject(toError(error));
      }
    });
  }

  return {
    get state(): TransportState {
      return state;
    },
    async connect(): Promise<void> {
      if (disposed) {
        throw new Error("transport is closed");
      }
      if (state === "ready") {
        return;
      }
      teardown();
      setState("connecting");
      errorEmitted = false;
      let connected: Socket | null = null;
      let lastError: Error = new Error("no Discord IPC socket found");
      for (const path of candidates) {
        try {
          connected = await openSocket(path);
          break;
        } catch (error) {
          lastError = toError(error);
        }
      }
      if (connected === null) {
        if (state !== "closed") {
          setState("disconnected");
        }
        emit("error", lastError);
        throw lastError;
      }
      socket = connected;
      attachSocket(connected);
      try {
        await handshake();
      } catch (error) {
        if (state !== "closed") {
          setState("disconnected");
        }
        if (!errorEmitted) {
          emit("error", error);
        }
        teardown();
        throw toError(error);
      }
    },
    setActivity,
    clear(): Promise<void> {
      if (state !== "ready") {
        return Promise.resolve();
      }
      return setActivity(null, randomUUID()).catch(() => undefined);
    },
    async close(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      teardown();
      setState("closed");
      emit("closed");
    },
    on(event: TransportEvent, listener: TransportListener): void {
      const subscribers = listeners.get(event) ?? new Set<TransportListener>();
      subscribers.add(listener);
      listeners.set(event, subscribers);
    },
    off(event: TransportEvent, listener: TransportListener): void {
      listeners.get(event)?.delete(listener);
    },
  };
}
