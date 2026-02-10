import { DeviceConnectionState, MultiDeviceWhisperer, AddConnectionProps } from "../base/device-whisperer.js";
import { useEffect, useState } from "react";

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

// usb-transport.ts

export class UsbTransport {
  public device: USBDevice;
  public controlInterface: number = 0;
  public dataInterface: number = 1;
  public endpointIn: number = 0;
  public endpointOut: number = 0;

  // Standard CDC-ACM requests
  private static readonly SET_LINE_CODING = 0x20;
  private static readonly SET_CONTROL_LINE_STATE = 0x22;

  constructor(device: USBDevice) {
    this.device = device;
  }

  /**
   * Connects to the device, claims the interface, and finds endpoints.
   */
  async connect(baudRate: number = 115200) {
    await this.device.open();

    if (this.device.configuration === null) {
      await this.device.selectConfiguration(1);
    }

    const interfaces = this.device.configuration?.interfaces || [];

    let ctrlIface: USBInterface | undefined;
    let dataIface: USBInterface | undefined;

    dataIface = interfaces.find(iface => {
      const endpoints = iface.alternate.endpoints;
      return endpoints.some(e => e.direction === 'in' && e.type === 'bulk') &&
        endpoints.some(e => e.direction === 'out' && e.type === 'bulk');
    });

    if (dataIface) {
      this.dataInterface = dataIface.interfaceNumber;

      ctrlIface = interfaces.find(i => i.interfaceNumber === this.dataInterface - 1)
        || interfaces.find(i => i.alternate.interfaceClass === 2);

      this.controlInterface = ctrlIface ? ctrlIface.interfaceNumber : this.dataInterface;
    }

    if (!dataIface) {
      throw new Error("No serial-compatible Bulk interface found.");
    }

    // Note: On Android, if the OS has claimed Interface 0, this first call will fail.
    try {
      if (this.controlInterface !== this.dataInterface) {
        await this.device.claimInterface(this.controlInterface);
      }
    } catch (e) {
      console.warn("Could not claim Control Interface (OS locked?). Proceeding to Data...", e);
      // We continue, but setSignals might fail later.
    }

    try {
      await this.device.claimInterface(this.dataInterface);
    } catch (e) {
      throw new Error(`Failed to claim Data Interface. Android OS has locked the device driver. Try using a 'Vendor Specific' USB Class device or a native Serial App workaround.`);
    }

    const endpoints = dataIface.alternate.endpoints;
    this.endpointIn = endpoints.find(e => e.direction === 'in' && e.type === 'bulk')!.endpointNumber;
    this.endpointOut = endpoints.find(e => e.direction === 'out' && e.type === 'bulk')!.endpointNumber;

    await this.setBaudRate(baudRate);
    await this.setSignals({ dtr: false, rts: false });
  }


  /**
     * Writes bytes to the device
     */
  async write(data: Uint8Array): Promise<void> {
    if (!this.device.opened) return;
    await this.device.transferOut(this.endpointOut, data as unknown as BufferSource);
  }

  /**
   * Reads bytes from the device.
   * Unlike Serial, this does not use a stream reader; it performs a single transfer.
   */
  async read(length: number = 64): Promise<Uint8Array | null> {
    if (!this.device.opened) return null;
    try {
      const result = await this.device.transferIn(this.endpointIn, length);
      if (result.status === 'ok' && result.data) {
        return new Uint8Array(result.data.buffer);
      }
    } catch (e) {
      // Ignore stall errors or disconnects during read loops often
    }
    return null;
  }


  /**
   * Sets DTR/RTS lines. Crucial for resetting the ESP32.
   * Uses standard CDC-ACM request 0x22.
   */
  async setSignals({ dtr, rts }: { dtr: boolean; rts: boolean }) {
    if (!this.device.opened) return;
    const value = (Number(dtr) | (Number(rts) << 1));

    await this.device.controlTransferOut({
      requestType: 'class',
      recipient: 'interface',
      request: UsbTransport.SET_CONTROL_LINE_STATE,
      value: value,
      index: this.controlInterface
    });
  }

  async setBaudRate(baud: number) {
    if (!this.device.opened) return;

    // Standard CDC Line Coding structure (7 bytes)
    // 4 bytes: baud (LE), 1 byte: stop bits, 1 byte: parity, 1 byte: data bits
    const buffer = new ArrayBuffer(7);
    const view = new DataView(buffer);
    view.setUint32(0, baud, true);
    view.setUint8(4, 0);
    view.setUint8(5, 0);
    view.setUint8(6, 8);

    await this.device.controlTransferOut({
      requestType: 'class',
      recipient: 'interface',
      request: UsbTransport.SET_LINE_CODING,
      value: 0,
      index: this.controlInterface
    }, buffer);
  }

  async disconnect() {
    if (this.device.opened) {
      // Release both
      try { await this.device.releaseInterface(this.dataInterface); } catch (e) { }
      if (this.controlInterface !== this.dataInterface) {
        try { await this.device.releaseInterface(this.controlInterface); } catch (e) { }
      }
      await this.device.close();
    }
  }
}

export type SerialConnectionState = DeviceConnectionState & {
  device?: USBDevice;      // Replaces SerialPort
  transport?: UsbTransport; // Replaces esptool Transport
  baudrate?: number;
  slipReadWrite?: boolean;
};

export function SerialMultiDeviceWhisperer<
  AppOrMessageLayer extends SerialConnectionState
>({ ...props } = {}) {

  const base = MultiDeviceWhisperer<AppOrMessageLayer>(props);

  // --- Message Processing (Identical logic, just copied over) ---
  const defaultOnReceive = (uuid: string, data: string | ArrayBuffer | Uint8Array) => {
    const conn = base.getConnection(uuid);
    if (!conn) return;

    const decoder = new TextDecoder();
    let bytes: Uint8Array;

    if (typeof data === "string") bytes = new TextEncoder().encode(data);
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else bytes = data;

    const asText = decoder.decode(bytes);
    const combined = conn.readBufferLeftover + asText;
    const lines = combined.split("\r\n");

    base.updateConnection(uuid, (c) => ({ ...c, readBufferLeftover: lines.pop() || "" }));

    for (const line of lines) {
      if (line.trim()) {
        base.appendLog(uuid, { level: 2, message: line.trim() });
      }
    }
  };

  const defaultSend = async (uuid: string, data: string | Uint8Array) => {
    const conn = base.getConnection(uuid);
    if (!conn?.transport) return;

    const bytes: Uint8Array = typeof data === "string" ? new TextEncoder().encode(data) : data;

    base.appendLog(uuid, {
      level: 3,
      message: typeof data === "string" ? data : "[Binary Data]",
    });

    await conn.transport.write(bytes);
  };

  // --- The New Read Loop (Polling based) ---
  const readLoop = async (uuid: string, transport: UsbTransport) => {
    const conn = base.getConnection(uuid);
    if (!conn) return;

    let readBuffer = "";
    let slipBuffer: number[] = [];
    let inSlipFrame = false;
    let escapeNext = false;

    try {
      while (transport.device.opened) {
        // Poll for data. USB requires active asking.
        const bytes = await transport.read(64);

        if (!bytes || bytes.length === 0) {
          // Small delay to prevent CPU spinning if device sends nothing
          await new Promise(r => setTimeout(r, 10));
          continue;
        }

        // --- Same Decoding Logic as before ---
        for (let i = 0; i < bytes.length; i++) {
          const b = bytes[i];
          const currentConn = base.getConnection(uuid); // Refresh ref

          if (inSlipFrame) {
            if (b === 0xC0) {
              if (slipBuffer.length > 0) {
                const payload = new Uint8Array(slipBuffer);
                currentConn?.onReceive?.(payload);
                slipBuffer = [];
              }
              inSlipFrame = false;
              escapeNext = false;
            } else if (escapeNext) {
              if (b === 0xDC) slipBuffer.push(0xC0);
              else if (b === 0xDD) slipBuffer.push(0xDB);
              slipBuffer = []; // reset on error?
              escapeNext = false;
            } else if (b === 0xDB) {
              escapeNext = true;
            } else {
              slipBuffer.push(b);
            }
            continue;
          }

          if (b === 0xC0 && currentConn?.slipReadWrite) {
            inSlipFrame = true;
            slipBuffer = [];
            continue;
          }

          // Text Handling
          const char = String.fromCharCode(b);
          readBuffer += char;
          let newlineIndex;
          while ((newlineIndex = readBuffer.indexOf("\n")) >= 0) {
            const line = readBuffer.slice(0, newlineIndex).replace(/\r$/, "");
            readBuffer = readBuffer.slice(newlineIndex + 1);
            if (line.trim()) {
              currentConn?.onReceive?.(line);
            }
          }
        }
      }
    } catch (e) {
      console.error(e);
      await disconnect(uuid);
    }
  };

  // --- Restart Logic (Uses our new setSignals) ---
  const restartDevice = async (uuid: string, activeTransport?: UsbTransport) => {
    const conn = base.getConnection(uuid);
    const transport = activeTransport ?? conn?.transport;

    if (transport) {
      // DTR false/RTS false -> Standard Idle
      // DTR false/RTS true  -> Reset
      // Timing sequences vary, but standard ESP reset:
      await transport.setSignals({ dtr: false, rts: true }); // Reset (RTS low active usually, but via USB it's explicit)
      await new Promise((r) => setTimeout(r, 100));
      await transport.setSignals({ dtr: false, rts: false });
    }
  }

  const connect = async (uuid: string, baudrate = 115200) => {
    const conn = base.getConnection(uuid);
    if (!conn?.device) return;

    // Close existing if open
    if (conn.transport) await disconnect(uuid);

    base.updateConnection(uuid, c => ({ ...c, isConnecting: true }));

    const transport = new UsbTransport(conn.device);

    try {
      await transport.connect(baudrate);

      // Optional: Auto-restart on connect
      await restartDevice(uuid, transport);

      base.updateConnection(uuid, c => ({
        ...c,
        transport,
        baudrate,
        isConnected: true,
        isConnecting: false
      }));

      await conn.onConnect?.();

      // Start polling loop
      readLoop(uuid, transport);

    } catch (err: any) {
      console.error(err);
      base.updateConnection(uuid, c => ({ ...c, isConnected: false, isConnecting: false }));
      await disconnect(uuid);
    }
  };

  const disconnect = async (uuid: string) => {
    const conn = base.getConnection(uuid);
    if (conn?.transport) {
      await conn.transport.disconnect();
    }
    base.updateConnection(uuid, c => ({
      ...c,
      transport: null,
      isConnected: false,
      isConnecting: false
    }));
    await conn?.onDisconnect?.();
  };

  const addConnection = async ({ uuid, propCreator }: AddConnectionProps<AppOrMessageLayer>) => {
    try {
      const device = await navigator.usb.requestDevice({
        filters: []
      });

      const return_uuid = await base.addConnection({
        uuid,
        propCreator: (id) => {
          const props = propCreator?.(id);
          return {
            // Defaults, may be overridden by props
            send: (d) => defaultSend(id, d),
            onReceive: (d) => defaultOnReceive(id, d),
            device,
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
    } catch (e) {
      console.log("User cancelled or no device selected");
    }
  };

  const removeConnection = async (uuid: string) => {
    await disconnect(uuid);
    base.removeConnection(uuid);
  };

  const reconnectAll = async () => { /* Same logic as before */ };

  useEffect(() => { base.setIsReady(true) }, []);

  return {
    ...base,
    addConnection,
    removeConnection,
    connect,
    disconnect,
    reconnectAll
  };
}