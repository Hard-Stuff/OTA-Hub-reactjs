import { Transport } from "esptool-js";
import { DeviceConnectionState, MultiDeviceWhisperer, AddConnectionProps } from "../base/device-whisperer.js";
import { useEffect } from "react";

/*
┌────────────────────────────────┐
│   Device Whisperer (Generic)   │ (connect/disconnect, state mgmt) - "Abstraction Layer"
├────────────────────────────────┤
│ > Serial Device Whisperer      │ (port selection, stream handling) - "Transport Layer"
├────────────────────────────────┤
│   Protobuf Device Whisperer    │ (encoders, decoders, topic routing) - "Message Layer"
├────────────────────────────────┤
│   Enhanced Device Whisperer    │ (e.g. custom fields, handlers) - "Application Layer"
└────────────────────────────────┘
*/

/* Raw Serial Connection types - the minimum required for most applications */
export type SerialConnectionState = DeviceConnectionState & {
  port?: SerialPort;
  baudrate?: number;
  transport?: Transport;
  slipReadWrite?: boolean;
};

export function SerialMultiDeviceWhisperer<
  AppOrMessageLayer extends SerialConnectionState
>({ ...props } = {}) {

  const base = MultiDeviceWhisperer<AppOrMessageLayer>(props);

  const defaultOnReceive = (
    uuid: string,
    data: string | ArrayBuffer | Uint8Array
  ) => {
    const conn = base.getConnection(uuid);
    if (!conn) return;

    const decoder = new TextDecoder();
    let bytes: Uint8Array;

    if (typeof data === "string") {
      bytes = new TextEncoder().encode(data);
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else {
      bytes = data;
    }

    const asText = decoder.decode(bytes);
    const combined = conn.readBufferLeftover + asText;
    const lines = combined.split("\r\n");

    base.updateConnection(uuid, (c) => ({
      ...c,
      readBufferLeftover: lines.pop() || ""
    }));

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        base.appendLog(uuid, {
          level: 2,
          message: trimmed,
        });
      }
    }
  };

  const defaultSend = async (uuid: string, data: string | Uint8Array) => {
    const conn = base.getConnection(uuid);
    if (!conn) return;

    // Convert to bytes
    const bytes: Uint8Array =
      typeof data === "string" ? new TextEncoder().encode(data) : data;

    // Log for debugging
    base.appendLog(uuid, {
      level: 3,
      message: typeof data === "string" ? data : btoa(String.fromCharCode(...bytes)),
    });

    if (!conn.transport) return;

    await conn.transport.write(bytes);
    return;
  };

  const readLoop = async (uuid: string, transport: Transport) => {
    const conn = base.getConnection(uuid);
    if (!conn) return;

    let readBuffer = ""; // accumulate ASCII/lines
    let slipBuffer: number[] = []; // accumulate SLIP frames
    let inSlipFrame = false; // are we inside a SLIP frame?
    let escapeNext = false;

    try {
      const reader = transport.rawRead();

      while (true) {
        const { value, done } = await reader.next();
        if (done || !value) break;

        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);

        for (let i = 0; i < bytes.length; i++) {
          const b = bytes[i];

          if (inSlipFrame) {
            // SLIP decoding
            if (b === 0xC0) {
              if (slipBuffer.length > 0) {
                // complete SLIP frame received
                const payload = new Uint8Array(slipBuffer);
                try {
                  conn.onReceive?.(payload);
                } catch (e) {
                  console.error("Failed to decode SLIP frame", e);
                  base.appendLog(uuid, {
                    level: 1,
                    message: "Failed to decode message",
                    timestamp: new Date(),
                  });
                }
                slipBuffer = [];
              }
              inSlipFrame = false;
              escapeNext = false;
            } else if (escapeNext) {
              if (b === 0xDC) slipBuffer.push(0xC0);
              else if (b === 0xDD) slipBuffer.push(0xDB);
              else {
                // protocol violation: discard frame
                slipBuffer = [];
                inSlipFrame = false;
              }
              escapeNext = false;
            } else if (b === 0xDB) {
              escapeNext = true;
            } else {
              slipBuffer.push(b);
            }
            continue;
          }

          if (b === 0xC0 && conn.slipReadWrite) {
            // start of a SLIP frame
            inSlipFrame = true;
            slipBuffer = [];
            escapeNext = false;
            continue;
          }

          // treat as normal ASCII text
          const char = String.fromCharCode(b);
          readBuffer += char;

          // check for newline
          let newlineIndex;
          while ((newlineIndex = readBuffer.indexOf("\n")) >= 0) {
            const line = readBuffer.slice(0, newlineIndex).replace(/\r$/, "");
            readBuffer = readBuffer.slice(newlineIndex + 1);
            if (line.trim()) {
              conn.onReceive?.(line);
            }
          }
        }
      }
    } catch (e) {
      base.appendLog(uuid, {
        level: 0,
        message: `[!] Read loop error: ${e}`,
      });
      await disconnect(uuid);
    } finally {
      base.updateConnection(uuid, (c) => ({
        ...c,
        transport: null,
        isConnected: false,
        isConnecting: false,
        autoConnect: false,
      }));
      base.appendLog(uuid, {
        level: 0,
        message: "[!] Serial disconnected",
      });
    }
  };

  const restartDevice = async (uuid: string, default_transport?: Transport) => {
    const conn = base.getConnection(uuid);

    const transport = default_transport ?? conn?.transport;

    if (transport) {
      await transport.setRTS(false);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await transport.setRTS(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } else {
      console.log("No transport yet");
    }
  }

  const connect = async (
    uuid: string,
    baudrate?: number,
    restart_on_connect = true,
  ) => {
    const conn = base.getConnection(uuid);
    if (!conn?.port) return;
    if (!conn?.transport) { await disconnect(uuid) };

    base.updateConnection(uuid, (c) => ({ ...c, isConnecting: true }));

    const use_baudrate = baudrate ?? conn.baudrate ?? 115200;

    const transport = new Transport(conn.port, false, false);

    try {
      await transport.connect(use_baudrate);

      if (restart_on_connect) { await restartDevice(uuid, transport) };

      base.updateConnection(uuid, (c) => ({
        ...c,
        transport,
        baudrate: use_baudrate,
        isConnected: true,
        isConnecting: false,
      }));

      base.appendLog(uuid, {
        level: 2,
        message: "[✓] Serial connected"
      });

      await conn.onConnect?.();

      await readLoop(uuid, transport);
    } catch (err: any) {
      base.updateConnection(uuid, (c) => ({
        ...c,
        isConnected: false,
        isConnecting: false
      }));

      base.appendLog(uuid, {
        level: 0,
        message: `[x] Serial connection error: ${err?.message || "Unknown error"}`
      });

      await disconnect(uuid);
    }
  };

  const disconnect = async (uuid: string, timeout = 2000) => {
    const conn = base.getConnection(uuid);

    if (conn?.transport) {
      try {
        // Attempt disconnect, but don’t hang if the port is crashed
        await Promise.race([
          conn.transport.disconnect(),
          new Promise((resolve) => setTimeout(resolve, timeout)),
        ]);
      } catch (e) {
        console.warn(`[${uuid}] Serial Disconnect error:`, e);
      }
    }

    // Always clear the transport and reset connection state
    base.updateConnection(uuid, (c) => ({
      ...c,
      transport: null,
      isConnected: false,
      isConnecting: false,
      autoConnect: false,
    }));

    await conn?.onDisconnect?.();
  };


  const addConnection = async (
    { uuid, propCreator }: AddConnectionProps<AppOrMessageLayer>
  ) => {
    const port = await navigator.serial.requestPort({
      filters: [{ usbVendorId: 0x303a }]
    });

    return await base.addConnection({
      uuid,
      propCreator: (id) => {
        const props = propCreator?.(id);
        return {
          send: props?.send || ((d) => defaultSend(id, d)),
          onReceive: props?.onReceive || ((d) => defaultOnReceive(id, d)),
          port,
          ...props
        } as Partial<AppOrMessageLayer>;
      }
    });
  };

  const removeConnection = async (uuid: string) => {
    try {
      await disconnect(uuid);
    } catch (e) { };
    base.removeConnection(uuid);
  };

  const reconnectAll = async (...connectionProps: any) => {
    const connections = [...base.connectionsRef.current]; // snapshot first
    await Promise.all(
      connections.map(async (c) => {
        await disconnect(c.uuid);
        await new Promise((res) => setTimeout(res, 250));
        return connect(c.uuid, ...connectionProps);
      })
    );
  };

  useEffect(() => {
    base.setIsReady(true) // Ready on page load by default
  }, [])

  return {
    ...base,
    addConnection,
    removeConnection,
    connect,
    disconnect,
    reconnectAll
  };
}
