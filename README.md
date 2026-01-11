# OTA Hub ReactJS

**ReactJS tools for interacting with Microprocessors and IoT devices (such as ESP32) over various transports.**

`ota-hub-reactjs` provides a set of React-friendly utilities to:

-   Read from multiple MCUs **in parallel** over a range of transports, including:
    -   Serial (USB)
    -   MQTT (e.g. with AWS IoT Core)
    -   Websockets
-   Flash firmware to ESP32 directly in browser
-   Handle Protobuf and other message layer wrappers

## Installation

```bash
npm install ota-hub-reactjs
# or
yarn add ota-hub-reactjs
```

This is a react lib, so you will need the peer dependencies:

```bash
npm install react react-dom
```

# Features

## Transport layers

-   All transport layers are designed to support multiple connections (thus devices) in parallel
-   You can mix and match tranport layers within your applications as separate dedicated `Device Whisperers`
-   All ConnectionStates are extendible, e.g.
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

Read and write to multiple MCUs in parallel over multiple serial connections.

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

## MQTT AWS IoT Core Streaming

Connect to MCUs that expose WebSocket interfaces for live data streaming.<br />
_Currently this is for a server that allows multiple devices as clients to connect through, rather than one device as a server itself_

```ts
import { MQTTMultiDeviceWhisperer } from "ota-hub-reactjs";

import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@aws-sdk/signature-v4";
import { HttpRequest } from "@aws-sdk/protocol-http";

// Get your AWS IoT Core Signed URL
const createAwsIotWssUrl = async () => {
    const endpoint = process.env.IOT_ENDPOINT!; // Your IoT Core Endpoint
    const region = process.env.IOT_REGION!; // Your IoT Core Region

    const signer = new SignatureV4({
        service: "iotdevicegateway",
        region,
        credentials: {
            accessKeyId: process.env.IOT_ACCESS_KEY_ID!,
            secretAccessKey: process.env.IOT_SECRET_ACCESS_KEY!,
        },
        sha256: Sha256,
    });

    const request = new HttpRequest({
        protocol: "wss:",
        hostname: endpoint,
        method: "GET",
        path: "/mqtt",
        headers: { host: endpoint },
    });

    const signed = await signer.presign(request, { expiresIn: 60 });
    const qs = new URLSearchParams(signed.query as Record<string, string>).toString();

    return {
        url: `${signed.protocol}//${signed.hostname}${signed.path}?${qs}`,
        clientId: `web-${Date.now()}`,
    };
};

const { url, clientId } = await createAwsIotWssUrl(); // Best done on a backend

const whisperer = MQTTMultiDeviceWhisperer<EnhancedMQTTConnectionState>({
    serverUrl: url,
    clientId: clientId,
    serverPort: 443, // Mosquito etc. are often 8883. IoT Core is MQTT over WS, so 443.
    subTopicFromUuid: (uuid) => `${uuid}/sub_topic`,
    pubTopicFromUuid: (uuid) => `${uuid}/pub_topic`,
    uuidFromMessage: (topic, _p) => topic.split("/")[0],
    autoConnect: false,
    connectOn: true, // connect to MQTT boker on .. can also have this state managed, i.e. when a user clicks a button
});

// Then as normal:
const uuid = "Thingname on AWS"
await whisperer.addConnection({ uuid });
const given_connection = await whisperer.getConnection(uuid)
given_connection.send("hello there"); // or stringified JSON or bytes. Sends on default pubTopic (from UUID)
```

## WebSocket Streaming

Connect to MCUs that expose WebSocket interfaces for live data streaming.<br />
_Currently this is for a server that allows multiple devices as clients to connect through, rather than one device as a server itself_

```tsx
import { WebsocketMultiDeviceWhisperer } from "ota-hub-reactjs";

const websocketDeviceWhisperer = new WebsocketMultiDeviceWhisperer<EnhancedWebsocketConnectionState>(
    "ws://192.168.1.100:8080"
);

// then as Serial
```

## Flash Firmware

**Currently Firmware flashing is only available on Serial connections.** Flash multiple MCUs with firmware images using esptool-js under the hood.

```ts
await Promise.all(
    serialDeviceWhisperer.connections.map((c) =>
        serialDeviceWhisperer.handleFlashFirmware({ uuid: c.uuid, firmwareBlob: blobToFlash! })
    )
);
```

# Message Layer Wrappers

Supports Protobuf and other custom message layers for structured communication. **Experimental feature, and those with familiarity with Protobuf might want to handle this themselves and call `.send` and `.onReceive` themselves.**

```ts
import { ProtobufMultiDeviceWhisperer } from "ota-hub-reactjs";

const protobufSerialDeviceWhisperer = ProtobufMultiDeviceWhisperer<
    EnhancedSerialConnectionState,
    TXType,
    TXFromESP,
    RXToESP
>({
    transportLayer: serialDeviceWhisperer,
    encodeRX: (msg) => RXToESP.encode(msg).finish(),
    decodeTX: (bytes) => TXFromESP.decode(bytes),
    messageTypeField: "txType",
    rxTopicHandlerMap: logHandlerMap,
});
```

# Contributing

Contributions are welcome! Please submit issues or pull requests via the GitHub repository.

# License

MIT License © 2026 OTA-Hub
