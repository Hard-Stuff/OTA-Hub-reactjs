import { useEffect, useRef, useState } from "react";

import { ESPLoader, FlashOptions, LoaderOptions, Transport } from "esptool-js";
import { AddConnectionProps, DeviceConnectionState, DeviceWhispererProps, MultiDeviceWhisperer } from "../base/device-whisperer.js";

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
  flashPort?: SerialPort;
  baudrate?: number;
  transport?: Transport;
  esp?: ESPLoader;
  slipReadWrite?: boolean;
  isFlashing: boolean;
  flashProgress: number;
  flashError: string;
};

export type FlashFirmwareProps = {
  uuid: string
  firmwareBlob?: Blob,
  fileArray?: FlashOptions["fileArray"]
}

export function ESP32MultiDeviceWhisperer<
  AppOrMessageLayer extends ESP32ConnectionState
>(
  { releasePortByDefault, ...props }: { releasePortByDefault: boolean } & DeviceWhispererProps<AppOrMessageLayer>
    = { releasePortByDefault: true }) {

  const base = MultiDeviceWhisperer<AppOrMessageLayer>(props);
  const defaultOnReceive = (uuid: string, data: string | Uint8Array) => {
    const text = typeof data === "string"
      ? data
      : new TextDecoder().decode(data);

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
      message: typeof data === "string" ? data : btoa(String.fromCharCode(...bytes)),
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

    try {
      const reader = transport.rawRead();

      while (true) {
        const conn = base.getConnection(uuid);
        if (!conn) { console.log("Kack!"); return };

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

          // treat as normal text (correctly)
          readBuffer += textDecoder.decode(new Uint8Array([b]), { stream: true });

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
    } finally {
      base.appendLog(uuid, {
        level: 0,
        message: "[!] Serial disconnected",
      });
      await disconnect(uuid);
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
    { commsOnly = false }: { commsOnly?: boolean } = {},
  ) => {
    const conn = base.getConnection(uuid);
    if (!conn) return;

    let port = conn?.port;

    if (!port) {
      // Reuse an already-granted JTAG port if there is one, so comms can
      // reopen after a flash without prompting the user again.
      const granted = await navigator.serial.getPorts();
      port =
        granted.find((p) => p.getInfo().usbVendorId === 0x303a) ??
        (await navigator.serial.requestPort({
          filters: [{ usbVendorId: 0x303a }],
        }));
      base.updateConnection(uuid, (c) => ({ ...c, port }));
    };

    base.updateConnection(uuid, (c) => ({ ...c, isConnecting: true }));

    const use_baudrate = baudrate ?? conn.baudrate ?? 115200;

    const transport = new Transport(port, false, false);

    try {
      if (commsOnly) {
        // Open the port for framed comms only. No esptool handshake, so the
        // board is never forced into download mode and keeps running its app.
        await transport.connect(use_baudrate);
      } else {
        const esploader = new ESPLoader({
          transport,
          baudrate: use_baudrate,
          enableTracing: false
        } as LoaderOptions);

        try {
          await esploader.main();
        } catch (e) { console.log("failed to esploader.main()", e); return; };

        try {
          const mac = await esploader.chip.readMac(esploader);
          console.log("Mac from device:", mac)
          base.updateConnection(uuid, (c) => ({ ...c, deviceMac: mac }));
        } catch (e) { console.log("Failed to read Mac address...") }

        if (restart_on_connect) { await restartDevice(uuid, transport) };
      }

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

      if (commsOnly) {
        // Run the read loop in the background so callers (e.g. a liveness
        // probe) regain control once the port is open, instead of awaiting
        // readLoop which only resolves when the connection closes.
        void readLoop(uuid, transport);
        return;
      }

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

    // Always clear the transport and reset connection state.
    // flashPort follows the same release rule as port: if we hold onto a
    // stale CH343 across reconnects, the next flash silently reuses it
    // and never prompts the user for the new board's flash port.
    base.updateConnection(uuid, (c) => ({
      ...c,
      port: releasePortByDefault ? null : c.port,
      transport: releasePortByDefault ? null : c.transport,
      flashPort: releasePortByDefault ? undefined : c.flashPort,
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

    const return_uuid = await base.addConnection({
      uuid,
      propCreator: (id) => {
        const props = propCreator?.(id);
        return {
          send: (d) => defaultSend(id, d),
          onReceive: (d) => defaultOnReceive(id, d),
          port,
          // Initial connection state
          ...base.createInitialConnectionState(id),
          // From props
          ...props
        } as Partial<AppOrMessageLayer>;
      }
    });

    const conn = base.getConnection(return_uuid)
    if (conn?.autoConnect)
      await connect(return_uuid)

    return return_uuid
  };

  const removeConnection = async (uuid: string) => {
    try {
      await disconnect(uuid);
    } catch (e) { };
    base.removeConnection(uuid);
  };

  // Prompt for the board's flash port (a CH343-style UART bridge) and store it
  // on the connection. Must be called from a user gesture, one prompt at a time.
  const requestFlashPort = async (uuid: string) => {
    const conn = base.getConnection(uuid);
    if (!conn) return;
    const flashPort = await navigator.serial.requestPort({
      filters: [{ usbVendorId: 0x1a86 }]
    });
    base.updateConnection(uuid, (c) => ({ ...c, flashPort }));
    return flashPort;
  };

  // Reboot the board into its app over the flash bridge (CH343). Its RTS line
  // is wired to EN, so this drives a real reset edge (GPIO0 high for a normal
  // boot, EN low, then EN high) that the native USB-JTAG software reset can't.
  const resetViaFlashPort = async (uuid: string) => {
    const conn = base.getConnection(uuid);
    const flashPort = conn?.flashPort;
    if (!flashPort) return false;
    const transport = new Transport(flashPort, false, false);
    try {
      await transport.connect(115200);
      await transport.setDTR(false);
      await transport.setRTS(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await transport.setRTS(false);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return true;
    } catch (e) {
      console.log("resetViaFlashPort failed", e);
      return false;
    } finally {
      try {
        await transport.disconnect();
      } catch (e) {
        console.log("resetViaFlashPort close error", e);
      }
    }
  };

  const reconnectAll = async (...connectionProps: any) => {
    const connectionIds = base.connections.map(c => c.uuid);

    await Promise.all(
      connectionIds.map(async (id) => {
        const c = base.getConnection(id);
        if (!c) return;
        await disconnect(c.uuid);
        await new Promise((res) => setTimeout(res, 250));
        return connect(c.uuid, ...connectionProps);
      })
    );
  };

  // This function now handles an entire device flashing session
  const handleFlashFirmware = async (uuid: string, assetsToFlash: { blob: Blob, address: number }[]) => {
    const conn = base.getConnection(uuid);
    // Flash over the dedicated flash port (e.g. a CH343 UART bridge) when one
    // has been selected. That bridge has the auto-reset circuit wired to
    // EN/GPIO0, so esptool can hard-reset the board into its app afterwards.
    // Fall back to the comms port if no flash port was chosen.
    const flashPort = conn?.flashPort ?? conn?.port;
    if (!conn || !flashPort || assetsToFlash.length === 0) return;

    await disconnect(uuid);

    base.updateConnection(uuid, (c) => ({ ...c, isFlashing: true, flashProgress: 0, flashError: undefined }));

    try {
      // --- Connect ONCE ---
      const transport = new Transport(flashPort, true);
      const esploader = new ESPLoader({
        transport,
        baudrate: 921600,
        enableTracing: false
      } as LoaderOptions);

      try {
        await esploader.main();
      } catch (e) { console.log("failed to esploader.main()", e); return; };

      // --- Prepare an ARRAY of files for the library ---
      const fileArray = await Promise.all(
        assetsToFlash.map(async ({ blob, address }) => {
          const arrayBuffer = await blob.arrayBuffer();
          const binaryString = Array.from(new Uint8Array(arrayBuffer))
            .map((b) => String.fromCharCode(b))
            .join("");
          return { data: binaryString, address };
        })
      );

      const flashOptions: FlashOptions = {
        fileArray, // Pass the whole array here
        flashSize: "keep",
        flashMode: "qio",
        flashFreq: "80m",
        eraseAll: fileArray.length > 1, // Writing more than 1 thing, so likely writing partitions.
        compress: true,
        reportProgress: (fileIndex, written, total) => {
          // You can enhance progress reporting to show which file is being flashed
          const progress = (written / total) * 100;
          console.log(`Flashing file ${fileIndex + 1}/${fileArray.length}: ${progress.toFixed(1)}%`);
          base.updateConnection(uuid, (c) => ({ ...c, flashProgress: progress }));
        },
      };

      // --- Call writeFlash ONCE with all files ---
      try {
        base.updateConnection(uuid, (c) => ({ ...c, flashProgress: -1 }));
        await esploader.writeFlash(flashOptions);
      } catch (e) { console.log("failed to esploader.writeFlash", e) };

      // --- Reset into the app ---
      // esptool-js' built-in hard reset only releases EN and never pulls it
      // low, so on a UART bridge it produces no reset edge and the board stays
      // in the download stub. Drive a real pulse over this port: GPIO0 high
      // (normal boot), EN low, then EN high.
      try {
        await transport.setDTR(false);
        await transport.setRTS(true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await transport.setRTS(false);
      } catch (e) { console.log("hard reset pulse failed", e); }

      // --- Disconnect ---
      try {
        await transport.disconnect();
      } catch (e) {
        console.log("failed to transport.disconnect", e);
        await flashPort?.readable?.cancel();
        await flashPort?.writable?.close();
        await flashPort?.close();
      }

      base.updateConnection(uuid, (c) => ({ ...c, isFlashing: false, flashProgress: 100 }));
    } catch (e: any) {
      console.error(`[${uuid}] Flashing failed:`, e);
      base.updateConnection(uuid, (c) => ({
        ...c,
        isFlashing: false,
        flashError: e?.message ?? "Unknown error",
      }));
    }
  };

  useEffect(() => {
    base.setIsReady(true) // Ready on page load by default
  }, [])

  return {
    ...base,
    addConnection,
    removeConnection,
    requestFlashPort,
    resetViaFlashPort,
    connect,
    disconnect,
    reconnectAll,
    handleFlashFirmware
  };
}
