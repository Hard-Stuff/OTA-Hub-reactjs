import { ESPLoader, FlashOptions, LoaderOptions, Transport } from "esptool-js";
import { DeviceConnectionState, MultiDeviceWhisperer, AddConnectionProps } from "@/base/device-whisperer.js";

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
  // Flashing
  isFlashing: boolean;
  flashProgress: number;
  flashError: string;
};

export type FlashFirmwareProps = {
  uuid: string
  firmwareBlob?: Blob,
  fileArray?: FlashOptions["fileArray"]
}

export function SerialMultiDeviceWhisperer<
  AppOrMessageLayer extends SerialConnectionState
>({ ...props } = {}) {

  const base = MultiDeviceWhisperer<AppOrMessageLayer>(props);

  const defaultOnReceive = (
    uuid: string,
    data: string | ArrayBuffer | Uint8Array
  ) => {
    const conn = base.connectionsRef.current.find((c) => c.uuid === uuid);
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
    const conn = base.connectionsRef.current.find((c) => c.uuid === uuid);
    if (!conn) return;

    const asString =
      typeof data === "string"
        ? data
        : btoa(String.fromCharCode(...data));

    base.appendLog(uuid, {
      level: 3,
      message: asString,
    });

    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : data;

    console.log("conn.transport?.write:", conn.transport?.write, bytes)
    await conn.transport?.write(bytes);
  };

  const readLoop = async (uuid: string, transport: Transport) => {
    try {
      while (true) {
        const conn = base.connectionsRef.current.find((c) => c.uuid === uuid);

        if (!transport?.rawRead || !conn) {
          console.log("Transport failed to load!", conn, conn?.transport, transport?.rawRead);
          break
        };

        const reader = transport?.rawRead();
        const { value, done } = await reader.next();
        if (done || !value) break;
        conn.onReceive?.(value);
      }
    } catch (e) {
      base.appendLog(uuid, {
        level: 0,
        message: `[!] Read loop error: ${e}`
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
        message: "[!] Serial disconnected"
      });
    }
  };

  const restartDevice = async (uuid: string, default_transport?: Transport) => {
    const conn = base.connectionsRef.current.find((c) => c.uuid === uuid);

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
    const conn = base.connectionsRef.current.find((c) => c.uuid === uuid);
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
    const conn = base.connectionsRef.current.find((c) => c.uuid === uuid);

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

  // This function now handles an entire device flashing session
  const handleFlashFirmware = async (uuid: string, assetsToFlash: { blob: Blob, address: number }[]) => {
    const conn = base.connectionsRef.current.find((c) => c.uuid === uuid);
    if (!conn || !conn.port || assetsToFlash.length === 0) return;

    await disconnect(uuid);
    base.updateConnection(uuid, (c) => ({ ...c, isFlashing: true, flashProgress: 0, flashError: undefined }));

    try {
      // --- Connect ONCE ---
      const transport = new Transport(conn.port, true);
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

      // --- Disconnect ---
      await esploader.after();
      try {
        await transport.disconnect();
      } catch (e) {
        console.log("failed to transport.disconnect", e);
        await conn.port?.readable?.cancel();
        await conn.port?.writable?.close();
        await conn.port?.close();
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

  return {
    ...base,
    addConnection,
    removeConnection,
    connect,
    disconnect,
    handleFlashFirmware,
    reconnectAll
  };
}
