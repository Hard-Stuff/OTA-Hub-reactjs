import { useEffect } from "react";

import { ESPLoader, FlashOptions, LoaderOptions, Transport } from "esptool-js";
import { SerialConnectionState, SerialMultiDeviceWhisperer } from "./serial-device-whisperer.js";

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
export type ESP32ConnectionState = SerialConnectionState & {
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
>({ ...props } = {}) {

  const base = SerialMultiDeviceWhisperer<AppOrMessageLayer>(props);

  // This function now handles an entire device flashing session
  const handleFlashFirmware = async (uuid: string, assetsToFlash: { blob: Blob, address: number }[]) => {
    const conn = base.getConnection(uuid);
    if (!conn || !conn.port || assetsToFlash.length === 0) return;

    await base.disconnect(uuid);
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

  useEffect(() => {
    base.setIsReady(true) // Ready on page load by default
  }, [])

  return {
    ...base,
    handleFlashFirmware,
  };
}
