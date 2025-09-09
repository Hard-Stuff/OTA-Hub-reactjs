import { AddConnectionProps, DeviceConnectionState, MultiDeviceWhisperer } from "@/base/device-whisperer.js";

/*
┌────────────────────────────────┐
│   Device Whisperer (Generic)   │ (connect/disconnect, state mgmt) - "Abstraction Layer"
├────────────────────────────────┤
│   Serial Device Whisperer      │ (port selection, stream handling) - "Transport Layer"
├────────────────────────────────┤
│ > Protobuf Device Whisperer    │ (encoders, decoders, topic routing) - "Message Layer"
├────────────────────────────────┤
│   Enhanced Device Whisperer    │ (e.g. custom fields, handlers) - "Application Layer"
└────────────────────────────────┘
*/

export type TopicHandlerContext<AppLayer extends DeviceConnectionState> = {
  base: ReturnType<typeof MultiDeviceWhisperer<AppLayer>>;
  uuid: string;
};

export type TopicHandlerMap<
  AppLayer extends DeviceConnectionState,
  Topic extends string | number,
  Message = any
> = {
    [K in Topic]?: (message: Message, context: TopicHandlerContext<AppLayer>) => void;
  };

export type ProtobufDeviceWhispererProps<
  AppLayer extends DeviceConnectionState,
  Topic extends string | number,
  MessageRX = any,
  MessageTX = any
> = {
  transportLayer: ReturnType<typeof MultiDeviceWhisperer<AppLayer>>;
  encodeRX: (message: MessageTX) => Uint8Array;
  decodeTX: (bytes: Uint8Array) => MessageRX;
  messageTypeField: keyof MessageRX;
  rxTopicHandlerMap: TopicHandlerMap<AppLayer, Topic, MessageRX>;
  HEADER?: Uint8Array;
  expectLength?: boolean
};

export function ProtobufMultiDeviceWhisperer<
  AppLayer extends DeviceConnectionState,
  Topic extends string | number,
  MessageRX = any,
  MessageTX = any
>({
  transportLayer,
  encodeRX,
  decodeTX,
  messageTypeField,
  rxTopicHandlerMap,
  HEADER = new Uint8Array([]),
}: ProtobufDeviceWhispererProps<AppLayer, Topic, MessageRX, MessageTX>) {

  // --- Utils ---
  const concatUint8Arrays = (a: Uint8Array, b: Uint8Array): Uint8Array => {
    const result = new Uint8Array(a.length + b.length);
    result.set(a);
    result.set(b, a.length);
    return result;
  };

  const wrapLengthPrefixed = (payload: Uint8Array): Uint8Array => {
    const length = payload.length;
    const header = new Uint8Array([
      (length >> 8) & 0xff, // Most significant byte first
      length & 0xff         // Least significant byte second
    ]);
    return concatUint8Arrays(header, payload);
  };

  const tryDecodeLengthPrefixed = (
    buffer: Uint8Array
  ): [MessageRX | null, Uint8Array] => {
    if (HEADER.length) {

      const findHeader = (buf: Uint8Array): number => {
        for (let i = 0; i < buf.length - 1; i++) {
          if (buf[i] === HEADER[0] && buf[i + 1] === HEADER[1]) return i;
        }
        return -1;
      };

      const headerIndex = findHeader(buffer);
      if (headerIndex === -1) return [null, buffer];

      buffer = buffer.slice(headerIndex);
    }

    const st_msg = HEADER.length + 2
    if (buffer.length < st_msg) return [null, buffer];

    const length = (buffer[HEADER.length] << 8) | buffer[HEADER.length + 1];
    if (buffer.length < st_msg + length) return [null, buffer];


    const messageBytes = buffer.slice(st_msg, st_msg + length);
    const leftover = buffer.slice(st_msg + length);

    try {
      const decoded = decodeTX(messageBytes);
      return [decoded, leftover];
    } catch {
      return [null, buffer.slice(1)];
    }
  };

  // --- New outbound API ---
  const sendProtobuf = (uuid: string, message: MessageTX) => {
    const encoded = encodeRX(message);
    const wrapped = wrapLengthPrefixed(encoded);
    const conn = transportLayer.connectionsRef.current.find(c => c.uuid === uuid);

    console.log("Sending Protobuf:", message, "bytes: ", [...wrapped]);
    conn?.send?.(wrapped);
  };

  // --- Inbound buffering ---
  const buffers: Record<string, Uint8Array> = {};

  const protoBufOnReceiveHandler = (uuid: string, data: string | Uint8Array) => {
    const bytes = typeof data === "string"
      ? new TextEncoder().encode(data)
      : data;

    buffers[uuid] = concatUint8Arrays(buffers[uuid] || new Uint8Array(), bytes);
    let buffer = buffers[uuid];

    while (buffer.length > 0) {
      const [msg, remaining] = tryDecodeLengthPrefixed(buffer);

      if (msg) {
        buffers[uuid] = remaining;
        const topic = msg[messageTypeField];
        const handler = rxTopicHandlerMap[topic as Topic];

        if (handler) {
          try {
            handler(msg, { base: transportLayer, uuid });
          } catch (err) {
            transportLayer.appendLog(uuid, {
              level: 0,
              message: `[!] Error in handler for topic "${topic}": ${err}`
            });
          }
        } else {
          transportLayer.appendLog(uuid, {
            level: 1,
            message: `[!] Unknown Protobuf topic: "${topic}"`
          });
        }
        buffer = buffers[uuid];
        continue;
      }

      // If not protobuf, see if we can log a line of text
      const newlineIdx = buffer.indexOf(10); // '\n'
      const headerIdx = buffer.findIndex((_, i) =>
        HEADER.every((h, idx) => buffer[i] + idx === h)
      );
      if (newlineIdx !== -1 && (headerIdx === -1 || newlineIdx < headerIdx)) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        buffers[uuid] = buffer;
        const text = new TextDecoder().decode(line).trim();
        if (text) {
          transportLayer.appendLog(uuid, {
            level: 2,
            message: text
          });
        }
        continue;
      }
      if (headerIdx > 0) {
        const garbage = buffer.slice(0, headerIdx);
        buffer = buffer.slice(headerIdx);
        buffers[uuid] = buffer;

        const preview = Array.from(garbage)
          .slice(0, 16)
          .map(b => b.toString(16).padStart(2, '0'))
          .join(' ');

        transportLayer.appendLog(uuid, {
          level: 1,
          message: `[!] Skipped invalid bytes before Protobuf header: ${preview}... (${garbage.length} bytes)`
        });
        continue;
      }


      break;
    }
    buffers[uuid] = buffer;
  };

  // --- Override addConnection to wrap onReceive ---
  const addConnection = async (
    { uuid, propCreator }: AddConnectionProps<AppLayer>
  ): Promise<string> => {
    return await transportLayer.addConnection({
      uuid,
      propCreator: (id: string) => {
        const props = propCreator?.(id);
        return {
          onReceive: (data: string | Uint8Array) =>
            protoBufOnReceiveHandler(id, data),
          ...props
        } as Partial<AppLayer>;
      }
    });
  };

  return {
    ...transportLayer,
    addConnection,
    sendProtobuf,
    protoBufOnReceiveHandler
  };
}
