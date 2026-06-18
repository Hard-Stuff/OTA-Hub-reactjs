import { useEffect, useRef, useState } from "react";

import { ESPLoader, FlashOptions, LoaderOptions, Transport } from "esptool-js";
import {
  AddConnectionProps,
  DeviceConnectionState,
  DeviceWhispererProps,
  useMultiDeviceWhisperer,
} from "../base/device-whisperer.js";

/*
┌────────────────────────────────┐
│   Device Whisperer (Generic)   │ (connect/disconnect, state mgmt) - "Abstraction Layer"
├────────────────────────────────┤
│ > ESP32 Device Whisperer       │ inherits from Serial Device Whisperer - (firmware flashing) - "Transport Layer"
├────────────────────────────────┤
│   Protobuf Device Whisperer    │ (encoders, decoders, topic routing) - "Message Layer"
├────────────────────────────────┤
│   Enhanced Device Whisperer    │ (e.g. custom fields, handlers) - "Application Layer"
└────────────────────────────────┘
*/

/* Raw Serial Connection types - the minimum required for most applications */
export type ESP32ConnectionState = DeviceConnectionState & {
  port?: SerialPort;
  baudrate?: number;
  transport?: Transport;
  esp?: ESPLoader;
  debugLogging?: false;
  slipReadWrite?: boolean;
  isFlashing: boolean;
  flashProgress: number;
  flashError: string;
};

export type FlashFirmwareProps = {
  uuid: string;
  firmwareBlob?: Blob;
  fileArray?: FlashOptions["fileArray"];
};

export function useESP32MultiDeviceWhisperer<
  AppOrMessageLayer extends ESP32ConnectionState,
>(
  {
    releasePortByDefault,
    ...props
  }: {
    releasePortByDefault: boolean;
  } & DeviceWhispererProps<AppOrMessageLayer> = { releasePortByDefault: true },
) {
  const base = useMultiDeviceWhisperer<AppOrMessageLayer>(props);
  const defaultOnReceive = (uuid: string, data: string | Uint8Array) => {
    const text =
      typeof data === "string" ? data : new TextDecoder().decode(data);

    const trimmed = text.trim();
    if (!trimmed) return;

    base.appendLog(uuid, {
      level: 2,
      message: trimmed,
    });
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
      message:
        typeof data === "string" ? data : btoa(String.fromCharCode(...bytes)),
    });

    if (!conn.transport) return;

    await conn.transport.write(bytes);
    return;
  };

  const readLoop = async (uuid: string, transport: Transport) => {
    const textDecoder = new TextDecoder();
    let readBuffer = ""; // accumulate ASCII/lines
    let slipBuffer: number[] = []; // accumulate SLIP frames
    let inSlipFrame = false; // are we inside a SLIP frame?
    let escapeNext = false;

    const reader = transport.rawRead();
    base.updateConnection(uuid, (c) => ({ ...c }));

    try {
      while (true) {
        const conn = base.getConnection(uuid);
        if (!conn) {
          console.log("Kack!");
          return;
        }

        if (conn.isFlashing || !conn.isConnected) break;

        const { value, done } = await reader.next();
        if (done || !value) break;

        const bytes =
          value instanceof Uint8Array ? value : new Uint8Array(value);

        for (let i = 0; i < bytes.length; i++) {
          const b = bytes[i];

          if (inSlipFrame) {
            // SLIP decoding
            if (b === 0xc0) {
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
              if (b === 0xdc) slipBuffer.push(0xc0);
              else if (b === 0xdd) slipBuffer.push(0xdb);
              else {
                // protocol violation: discard frame
                slipBuffer = [];
                inSlipFrame = false;
              }
              escapeNext = false;
            } else if (b === 0xdb) {
              escapeNext = true;
            } else {
              slipBuffer.push(b);
            }
            continue;
          }

          if (b === 0xc0 && conn.slipReadWrite) {
            // start of a SLIP frame
            inSlipFrame = true;
            slipBuffer = [];
            escapeNext = false;
            continue;
          }

          // treat as normal text (correctly)
          readBuffer += textDecoder.decode(new Uint8Array([b]), {
            stream: true,
          });

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
      await new Promise((resolve) => setTimeout(resolve, 100)); // Little breather before attempt any disconnects
    } catch (e) {
      base.appendLog(uuid, {
        level: 0,
        message: `[!] Read loop error: ${e}`,
      });
    } finally {
      base.updateConnection(uuid, (c) => ({ ...c }));

      const conn = base.getConnection(uuid);

      if (conn?.isConnected) {
        await disconnect(uuid);
      }
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
  };

  const connect = async (
    uuid: string,
    baudrate?: number,
    restart_on_connect = true,
  ) => {
    const conn = base.getConnection(uuid);
    if (!conn) return;

    let port = conn?.port;

    if (!port) {
      port = await navigator.serial.requestPort({
        filters: [{ usbVendorId: 0x303a }],
      });
      base.updateConnection(uuid, (c) => ({ ...c, port }));
    } else {
      try {
        const oldInfo = port.getInfo();
        const authorizedPorts = await navigator.serial.getPorts();
        const freshPort = authorizedPorts.find(
          (p) =>
            p.getInfo().usbVendorId === oldInfo.usbVendorId &&
            p.getInfo().usbProductId === oldInfo.usbProductId,
        );

        if (freshPort) {
          port = freshPort; // Swap out the dead pointer
          base.updateConnection(uuid, (c) => ({ ...c, port }));
        }
      } catch (e) {
        console.warn(`[${uuid}] Failed to silently heal port reference:`, e);
      }
    }

    base.updateConnection(uuid, (c) => ({ ...c, isConnecting: true }));

    const use_baudrate = baudrate ?? conn.baudrate ?? 115200;

    const transport = new Transport(port, false, false);

    try {
      const esploader = new ESPLoader({
        transport,
        baudrate: use_baudrate,
        enableTracing: !!conn.debugLogging,
        debugLogging: !!conn.debugLogging,
      } as LoaderOptions);

      try {
        await esploader.main();
      } catch (e) {
        console.log("failed to esploader.main()", e);
        return;
      }

      try {
        const mac = await esploader.chip.readMac(esploader);
        console.log("Mac from device:", mac);
        base.updateConnection(uuid, (c) => ({ ...c, deviceMac: mac }));
      } catch (e) {
        console.log("Failed to read Mac address...");
      }

      if (restart_on_connect) {
        await restartDevice(uuid, transport);
      }

      base.updateConnection(uuid, (c) => ({
        ...c,
        transport,
        esp: esploader,
        baudrate: use_baudrate,
        isConnected: true,
        isConnecting: false,
      }));

      base.appendLog(uuid, {
        level: 2,
        message: "[✓] Serial connected",
      });

      await conn.onConnect?.();

      // FIRE AND FORGET
      // We initiate the read loop but DO NOT await it, returning control immediately.
      readLoop(uuid, transport).catch((e) =>
        console.error(`[${uuid}] Background read loop failed:`, e),
      );
    } catch (err: any) {
      base.updateConnection(uuid, (c) => ({
        ...c,
        isConnected: false,
        isConnecting: false,
      }));

      base.appendLog(uuid, {
        level: 0,
        message: `[x] Serial connection error: ${err?.message || "Unknown error"}`,
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
      port: releasePortByDefault ? null : c.port,
      transport: releasePortByDefault ? null : c.transport,
      esp: releasePortByDefault ? null : c.transport,
      isConnected: false,
      isConnecting: false,
      autoConnect: false,
    }));

    base.appendLog(uuid, {
      level: 0,
      message: "[!] Serial disconnected",
    });

    await conn?.onDisconnect?.();
  };

  const addConnection = async ({
    uuid,
    propCreator,
  }: AddConnectionProps<AppOrMessageLayer>) => {
    const port = await navigator.serial.requestPort({
      filters: [{ usbVendorId: 0x303a }],
    });

    let deviceId = uuid;

    // If no UUID provided, try to read the MAC address before registering the connection
    if (!uuid) {
      // 1. Interrogate the port for the MAC address BEFORE registering the connection
      try {
        const tempTransport = new Transport(port, false, false);
        const tempLoader = new ESPLoader({
          transport: tempTransport,
          baudrate: 115200,
          enableTracing: false,
        } as LoaderOptions);

        await tempLoader.main();
        const mac = await tempLoader.chip.readMac(tempLoader);
        if (mac) {
          deviceId = mac; // Swap 'unnamed_device_0' for the actual MAC
        }

        // Disconnect to release the port so connect() can start fresh
        await tempTransport.disconnect();
      } catch (e) {
        console.warn(
          "Failed to pre-fetch MAC address. Falling back to default UUID.",
          e,
        );
      }
    }

    // 2. Register the connection using the real MAC address
    const return_uuid = await base.addConnection({
      uuid: deviceId,
      propCreator: (id) => {
        const props = propCreator?.(id);
        return {
          send: (d) => defaultSend(id, d),
          onReceive: (d) => defaultOnReceive(id, d),
          port,
          ...base.createInitialConnectionState(id),
          deviceMac: deviceId, // Lock it in immediately
          ...props,
        };
      },
    });

    const conn = base.getConnection(return_uuid);
    if (conn?.autoConnect) await connect(return_uuid);

    return return_uuid;
  };

  const removeConnection = async (uuid: string) => {
    try {
      await disconnect(uuid);
    } catch (e) {}
    base.removeConnection(uuid);
  };

  const reconnectAll = async (...connectionProps: any) => {
    const connectionIds = base.connections.map((c) => c.uuid);

    await Promise.all(
      connectionIds.map(async (id) => {
        const c = base.getConnection(id);
        if (!c) return;
        await disconnect(c.uuid);
        await new Promise((res) => setTimeout(res, 250));
        return connect(c.uuid, ...connectionProps);
      }),
    );
  };

  // This function now handles an entire device flashing session
  const handleFlashFirmware = async (
    uuid: string,
    assetsToFlash: { blob: Blob; address: number }[],
  ) => {
    // Capture the original connection and port reference before disconnect
    const conn = base.getConnection(uuid);

    // 1. Bail if we don't have the required state
    if (!conn || !conn.port || assetsToFlash.length === 0) return;

    const prevAutoConnect = conn.autoConnect;
    base.updateConnection(uuid, (c) => ({
      ...c,
      port: conn.port, // Restore the port into state in case disconnect wiped it
      isFlashing: true,
      flashProgress: 0,
      flashError: undefined,
      autoConnect: false,
    }));


    if (conn.isConnected) await disconnect(uuid);
    await new Promise((resolve) => setTimeout(resolve, 400));

    try {
      // --- Connect ONCE ---
      const transport = new Transport(conn.port, true);
      const esploader = new ESPLoader({
        transport,
        baudrate: 921600,
        enableTracing: !!conn.debugLogging,
        debugLogging: !!conn.debugLogging,
      } as LoaderOptions);

      // This may fail, that'll bubble the failure up to the upper try/catch
      await esploader.main();

      // --- Prepare an ARRAY of files for the library ---
      const fileArray = await Promise.all(
        assetsToFlash.map(async ({ blob, address }) => {
          const arrayBuffer = await blob.arrayBuffer();
          const binaryString = Array.from(new Uint8Array(arrayBuffer))
            .map((b) => String.fromCharCode(b))
            .join("");
          return { data: binaryString, address };
        }),
      );

      let lastRenderTime = 0;

      const flashOptions: FlashOptions = {
        fileArray,
        flashSize: "keep",
        flashMode: "qio",
        flashFreq: "80m",
        eraseAll: fileArray.length > 1, // Writing more than 1 thing, so likely writing partitions.
        compress: true,
        reportProgress: (fileIndex, written, total) => {
          const progress = (written / total) * 100;
          const now = performance.now();

          // Throttle UI updates to at most once every 100ms (~10 FPS),
          // but ALWAYS ensure the final 100% tick renders.
          if (now - lastRenderTime > 100 || written === total) {
            lastRenderTime = now;

            // Optional: Only log every 100ms as well to prevent console spam
            console.log(
              `Flashing file ${fileIndex + 1}/${fileArray.length}: ${progress.toFixed(1)}%`,
            );

            base.updateConnection(uuid, (c) => ({
              ...c,
              flashProgress: progress,
            }));
          }
        },
      };

      // --- Call writeFlash ONCE with all files ---
      base.updateConnection(uuid, (c) => ({ ...c, flashProgress: -1 }));
      await esploader.writeFlash(flashOptions);

      // --- Disconnect cleanly ---
      await esploader.after();
      try {
        await transport.disconnect();
      } catch (e) {
        console.log("failed to transport.disconnect", e);
        await conn.port?.readable?.cancel();
        await conn.port?.writable?.close();
        await conn.port?.close();
      }

      base.updateConnection(uuid, (c) => ({
        ...c,
        isFlashing: false,
        flashProgress: 100,
        autoConnect: prevAutoConnect,
      }));
    } catch (e: any) {
      console.error(`[${uuid}] Flashing failed:`, e);
      base.updateConnection(uuid, (c) => ({
        ...c,
        isFlashing: false,
        flashError: e?.message ?? "Unknown error",
      }));

      // Attempt recovery
    } finally {
      await connect(uuid);
    }
  };

  useEffect(() => {
    base.setIsReady(true); // Ready on page load by default
  }, []);

  return {
    ...base,
    addConnection,
    removeConnection,
    connect,
    disconnect,
    reconnectAll,
    handleFlashFirmware,
  };
}
