import { useEffect, useRef } from "react";
import { DeviceConnectionState, MultiDeviceWhisperer, AddConnectionProps, DeviceWhispererProps } from "../base/device-whisperer.js";
import mqtt from "mqtt";

/*
┌────────────────────────────────┐
│   Device Whisperer (Generic)   │ (connect/disconnect, state mgmt) - "Abstraction Layer"
├────────────────────────────────┤
│ > MQTT Device Whisperer        │ (device URL routing, stream handling) - "Transport Layer"
├────────────────────────────────┤
│   Protobuf Device Whisperer    │ (encoders, decoders, topic routing) - "Message Layer"
├────────────────────────────────┤
│   Enhanced Device Whisperer    │ (e.g. custom fields, handlers) - "Application Layer"
└────────────────────────────────┘
*/

export type MQTTConnectionState = DeviceConnectionState & {
  pingFunction?: (props?: any) => void,
  touchHeartbeat?: () => void,
};

export function MQTTMultiDeviceWhisperer<
  AppOrMessageLayer extends MQTTConnectionState
>(
  {
    serverUrl,
    uuidFromMessage,
    subTopicFromUuid = undefined,
    pubTopicFromUuid = undefined,
    serverPort = 8883,
    clientId = undefined,
    username = undefined,
    password = undefined,
    autoConnect = true,
    ...props
  }: {
    serverUrl: string,
    uuidFromMessage: (topic: string, payload: Buffer<ArrayBufferLike>) => string,
    subTopicFromUuid?: (uuid: string) => string,
    pubTopicFromUuid?: (uuid: string) => string,
    serverPort?: number,
    clientId?: string,
    username?: string,
    password?: string,
    autoConnect?: boolean,
  } & DeviceWhispererProps<AppOrMessageLayer>
) {

  const base = MultiDeviceWhisperer<AppOrMessageLayer>(props);

  const clientRef = useRef<mqtt.MqttClient | null>(null);
  const isUnmountedRef = useRef(false);
  const watchdogTimers = useRef<Record<string, { ping?: NodeJS.Timeout, warn?: NodeJS.Timeout, fail?: NodeJS.Timeout } | undefined>>({});
  const addingConnections = useRef<Set<string>>(new Set());

  const connectToMQTTServer = () => {
    isUnmountedRef.current = false;

    if (clientRef.current) {
      if (clientRef.current.connected) {
        base.setIsReady(true);
        return;
      }
      clientRef.current.end(true);
    }

    try {
      const new_client = mqtt.connect(
        serverUrl,
        {
          port: serverPort,
          clientId: clientId,
          username,
          password,
          clean: true,
          keepalive: 30,
          reconnectPeriod: 3000,
        } as mqtt.IClientOptions);

      new_client.on("connect", () => {
        console.log("MQTT Whisperer Connected");
        base.setIsReady(true);
      });

      new_client.on("reconnect", () => {
        console.log("MQTT Whisperer Reconnecting...");
        base.setIsReady(false);
      });

      new_client.on("close", () => {
        console.log("MQTT Whisperer Closed");
        base.setIsReady(false);
      });
      new_client.on("error", (err) => {
        base.setIsReady(false);
        console.error("MQTT Whisperer Error:", err)
      });

      new_client.on("message", (topic, payload) => {
        if (isUnmountedRef.current) return;

        const uuid = uuidFromMessage(topic, payload)
        const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
        if (!uuid) return;

        const conn = base.getConnection(uuid);
        if (!conn) {
          console.warn("Received message for unknown connection:", uuid);
          return;
        }

        conn.touchHeartbeat?.();
        conn.onReceive?.(bytes);
      });

      clientRef.current = new_client;
    } catch (err) {
      console.error("MQTT init failed:", err);
      base.setIsReady(false);
    }

    return () => {
      isUnmountedRef.current = true;
      base.setIsReady(false);

      Object.keys(watchdogTimers.current).forEach((uuid) => {
        const timers = watchdogTimers.current[uuid];
        if (timers) {
          clearTimeout(timers.ping);
          clearTimeout(timers.warn);
          clearTimeout(timers.fail);
        }
      });
      watchdogTimers.current = {};

      if (clientRef.current) {
        clientRef.current.removeAllListeners();
        clientRef.current.end(true);
      }

      clientRef.current = null;
    };
  }

  const connect = async (uuid: string) => {
    const conn = base.getConnection(uuid);
    if (!clientRef.current || isUnmountedRef.current || !conn) return;

    const topic = subTopicFromUuid?.(uuid) ?? uuid
    if (clientRef.current.connected && !clientRef.current.disconnecting) {
      clientRef.current.subscribe(topic, { qos: 1 }, async (err) => {
        if (err) console.error("Subscribe failed:", err);
        else {
          console.log("MQTT Subscribed:", topic);
          conn.onConnect?.()
        }
      });
    } else {
      console.warn("Skipped subscribe - client disconnected or unmounted");
    }
  };

  const disconnect = async (uuid: string) => {
    if (!clientRef.current || isUnmountedRef.current) return;

    const topic = subTopicFromUuid?.(uuid) ?? uuid
    if (clientRef.current.connected && !clientRef.current.disconnecting) {
      clientRef.current.unsubscribe(topic, async (err) => {
        if (err) console.error("Unsubscribe failed:", err);
        else {
          console.log("MQTT Unsubscribed:", topic);
        }
      });
    } else {
      console.warn("Skipped subscribe - client disconnected or unmounted");
    }
  };

  function touchHeartbeat(uuid: string) {
    if (isUnmountedRef.current) return; // Stop if unmounted

    clearTimeout(watchdogTimers.current[uuid]?.ping);
    clearTimeout(watchdogTimers.current[uuid]?.warn);
    clearTimeout(watchdogTimers.current[uuid]?.fail);

    const currentConn = base.getConnection(uuid);

    base.updateConnection(uuid, (c) => ({
      ...c,
      isConnected: true,
      isConnecting: false
    }));

    const ping = setTimeout(() => {
      if (isUnmountedRef.current) return;
      currentConn?.pingFunction?.();
    }, 25000);

    const warn = setTimeout(() => {
      if (isUnmountedRef.current) return;
      base.updateConnection(uuid, (c) => ({ ...c, isConnected: false, isConnecting: true }));
    }, 30000);

    const fail = setTimeout(() => {
      if (isUnmountedRef.current) return;
      base.updateConnection(uuid, (c) => ({ ...c, isConnected: false, isConnecting: false }));
    }, 60000);

    watchdogTimers.current[uuid] = { ping, warn, fail };
  }

  const defaultOnReceive = (
    uuid: string,
    data: string | ArrayBuffer | Uint8Array
  ) => {
    const conn = base.getConnection(uuid);
    if (!conn) return;

    conn.touchHeartbeat?.();

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

    base.appendLog(uuid, {
      level: 2,
      message: asText,
    });
  };

  const defaultSend = async (
    uuid: string,
    data: string | Uint8Array
  ) => {
    const conn = base.getConnection(uuid);
    if (!conn) return;

    const payload =
      typeof data === 'string'
        ? new TextEncoder().encode(data)
        : data;

    base.appendLog(uuid, {
      level: 5,
      message: payload,
    });

    clientRef.current?.publish(pubTopicFromUuid?.(uuid) ?? uuid, payload as any); // TS is wrong here!
  };

  const addConnection = async (
    { uuid, propCreator }: AddConnectionProps<AppOrMessageLayer>
  ) => {
    if (!clientRef.current || isUnmountedRef.current) return;

    if (!uuid) {
      Error("In MQTT you MUST define a UUID otherwise we don't know what device we're connecting to!")
      return
    }

    if (base.connectionsRef.current.some(c => c.uuid === uuid) || addingConnections.current.has(uuid)) {
      return;
    }

    await base.addConnection({
      uuid,
      propCreator: (id) => {
        const props = propCreator?.(id);

        return {
          // Defaults, may be overridden by props
          send: (d) => defaultSend(id, d),
          onReceive: (d) => defaultOnReceive(id, d),
          touchHeartbeat: () => touchHeartbeat(id),
          // Initial connection state
          ...base.createInitialConnectionState(id),
          // From props
          ...props
        } as Partial<AppOrMessageLayer>;
      }
    });

    // Delete this adding connections item
    addingConnections.current.delete(uuid);

    // Connect immediately
    connect(uuid)

    return uuid;
  }

  const removeConnection = async (uuid: string) => {
    await disconnect(uuid);
    base.removeConnection(uuid);
  };

  const reconnectAll = async () => {
    for (const c of base.connectionsRef.current) {
      await disconnect(c.uuid);
      await new Promise((res) => setTimeout(res, 250));
    }
    for (const c of base.connectionsRef.current) {
      await connect(c.uuid);
    }
  };

  useEffect(() => {
    if (!(autoConnect || props.connectOn)) return;

    const cleanup = connectToMQTTServer();
    return cleanup;
  }, [serverUrl, props.connectOn]);

  return {
    ...base,
    addConnection,
    removeConnection,
    connect,
    disconnect,
    reconnectAll,
    connectToMQTTServer
  };
}
