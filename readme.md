# OTA Hub ReactJS

**ReactJS tools for interacting with MCUs such as ESP32 over OTA.**  

`ota-hub-reactjs` provides a set of React-friendly utilities to:

- Flash firmware to microcontrollers (ESP32 and similar)
- Read from multiple MCUs over serial **in parallel**
- Connect to MCUs via wireless transport stacks such as WebSockets for real-time streaming
- Handle Protobuf and other message layer wrappers 


## Installation

```bash
npm install ota-hub-reactjs
# or
yarn add ota-hub-reactjs
```

Peer dependencies:

```bash
npm install react react-dom
```

# Features

## Transport layers

- All transport layers are designed to support multiple connections (thus devices) in parallel
- You can mix and match tranport layers within your applications
- All ConnectionStates are extendible, e.g.
    ```ts
    export type EnhancedSerialConnectionState = SerialConnectionState & {
        dataPoints: DataPoint[];
        isRecording: boolean;
        edgeModelVersion: string;
        wifiSignal: number;
        wifiSSID: string;
        batteryLevel: number;
    };
    ```

### Serial Communication
Read and write to multiple MCUs concurrently over serial connections.

```tsx
import { SerialMultiDeviceWhisperer, SerialConnectionState } from "ota-hub-reactjs";

const serialDeviceWhisperer = new SerialMultiDeviceWhisperer<EnhancedSerialConnectionState>();
serialDeviceWhisperer.addConnection(); // Web browser will prompt for which Serial COM to use.

<YourLoggingComponent logs={
    serialDeviceWhisperer.connections.map(
        (c) => c..logs || []
    )
}/>
```

## WebSocket Streaming
Connect to MCUs that expose WebSocket interfaces for live data streaming.<br />
_Currently this is for a server that allows multiple devices as clients to connect through, rather than one device as a server itself_

```tsx
import { WebsocketMultiDeviceWhisperer } from "ota-hub-reactjs";

const websocketDeviceWhisperer = new WebsocketMultiDeviceWhisperer<EnhancedWebsocketConnectionState>("ws://192.168.1.100:8080");

// then as Serial
```

## Flash Firmware
Flash multiple MCUs with firmware images using esptool-js under the hood. - Currently only implemented in Serial, more to come!

```ts
await Promise.all(
    serialDeviceWhisperer.connections
      .map(c => serialDeviceWhisperer.handleFlashFirmware({ uuid: c.uuid, firmwareBlob: blobToFlash! }))
);
```

# Message Layer Wrappers
Supports Protobuf and other custom message layers for structured communication.

```ts
import { ProtobufMultiDeviceWhisperer } from "ota-hub-reactjs";


const protobufSerialDeviceWhisperer = ProtobufMultiDeviceWhisperer<EnhancedSerialConnectionState, TXType, TXFromESP, RXToESP>({
  transportLayer: serialDeviceWhisperer,
  encodeRX: (msg) => RXToESP.encode(msg).finish(),
  decodeTX: (bytes) => TXFromESP.decode(bytes),
  messageTypeField: "txType",
  rxTopicHandlerMap: logHandlerMap
});
```
# Contributing
Contributions are welcome! Please submit issues or pull requests via the GitHub repository.

# License
MIT License © 2025 OTA Hub
