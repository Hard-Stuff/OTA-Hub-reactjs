import { useEffect, useRef } from "react";
import {
  DeviceConnectionState,
  MultiDeviceWhisperer,
  AddConnectionProps,
  DeviceWhispererProps,
} from "../base/device-whisperer.js";
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

type MQTTPayload = string | Uint8Array | ArrayBuffer;
type MQTTTopicCallback = (payload: MQTTPayload, topic: string) => void;

export type MQTTConnectionState = DeviceConnectionState & {
  /**
   * Publishes a payload to any explicit MQTT topic.
   */
  publish?: (topic: string, payload: MQTTPayload) => void | Promise<void>;
  /**
   * Subscribes a callback for a specific topic. Returns an unsubscribe function.
   */
  subscribeCallbackToTopic?: (
    topic: string,
    callback: MQTTTopicCallback,
  ) => () => void;
  pingFunction?: (props?: any) => void;
  touchHeartbeat?: () => void;
};

export function MQTTMultiDeviceWhisperer<
  AppOrMessageLayer extends MQTTConnectionState,
>({
  serverUrl,
  serverUrlFnc,
  uuidFromMessage,
  subTopicFromUuid = undefined,
  pubTopicFromUuid = undefined,
  serverPort = 443,
  clientId = undefined,
  username = undefined,
  password = undefined,
  serverAutoConnect = true,
  serverConnectOn = false,
  enableWatchdog = true,
  ...props
}: {
  serverUrl?: string;
  serverUrlFnc?: () => Promise<string> | string;
  uuidFromMessage: (topic: string, payload: Buffer<ArrayBufferLike>) => string;
  subTopicFromUuid?: (uuid: string) => string;
  pubTopicFromUuid?: (uuid: string) => string;
  serverPort?: number;
  clientId?: string;
  username?: string;
  password?: string;
  serverAutoConnect?: boolean;
  serverConnectOn?: boolean;
  enableWatchdog?: boolean;
} & DeviceWhispererProps<AppOrMessageLayer>) {
  const base = MultiDeviceWhisperer<AppOrMessageLayer>(props);

  const clientRef = useRef<mqtt.MqttClient | null>(null);
  const isUnmountedRef = useRef(false);

  // ✨ NEW: Manage our own reconnect timer
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const watchdogTimers = useRef<
    Record<
      string,
      | { ping?: NodeJS.Timeout; warn?: NodeJS.Timeout; fail?: NodeJS.Timeout }
      | undefined
    >
  >({});

  const addingConnections = useRef<Set<string>>(new Set());
  const topicCallbacksRef = useRef<Map<string, Set<MQTTTopicCallback>>>(
    new Map(),
  );

  const hasCallbackForTopic = (topic: string) => {
    const callbacks = topicCallbacksRef.current.get(topic);
    return !!callbacks && callbacks.size > 0;
  };

  const hasOtherConnectionUsingTopic = (
    topic: string,
    excludingUuid?: string,
  ) => {
    return base.connections.some((connection) => {
      if (excludingUuid && connection.uuid === excludingUuid) return false;
      const connectionTopic =
        subTopicFromUuid?.(connection.uuid) ?? connection.uuid;
      return connectionTopic === topic;
    });
  };

  const normalizePayload = (payload: MQTTPayload): Uint8Array => {
    if (typeof payload === "string") {
      return new TextEncoder().encode(payload);
    }
    if (payload instanceof ArrayBuffer) {
      return new Uint8Array(payload);
    }
    return payload;
  };

  const publish = async (
    topic: string,
    payload: MQTTPayload,
    uuidForLogs?: string,
  ) => {
    const client = clientRef.current;
    if (!client || isUnmountedRef.current) return;

    const bytes = normalizePayload(payload);

    if (uuidForLogs) {
      base.appendLog(uuidForLogs, {
        level: 5,
        message: bytes,
      });
    }

    await new Promise<void>((resolve, reject) => {
      client.publish(topic, bytes as any, { qos: 1 }, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  };

  const subscribeCallbackToTopic = (
    topic: string,
    callback: MQTTTopicCallback,
  ) => {
    if (!topic) return () => {};

    const topicCallbacks =
      topicCallbacksRef.current.get(topic) ?? new Set<MQTTTopicCallback>();
    const topicAlreadyRegistered = topicCallbacksRef.current.has(topic);
    topicCallbacks.add(callback);
    topicCallbacksRef.current.set(topic, topicCallbacks);

    const client = clientRef.current;
    if (client?.connected && !client.disconnecting && !topicAlreadyRegistered) {
      client.subscribe(topic, { qos: 1 }, (err) => {
        if (err) console.error("Topic callback subscribe failed:", err);
      });
    }

    return () => {
      const currentCallbacks = topicCallbacksRef.current.get(topic);
      if (!currentCallbacks) return;

      currentCallbacks.delete(callback);

      if (currentCallbacks.size > 0) return;

      topicCallbacksRef.current.delete(topic);

      // Keep topic subscribed when at least one managed connection still uses it.
      if (hasOtherConnectionUsingTopic(topic)) return;

      const latestClient = clientRef.current;
      if (latestClient?.connected && !latestClient.disconnecting) {
        latestClient.unsubscribe(topic, (err) => {
          if (err) console.error("Topic callback unsubscribe failed:", err);
        });
      }
    };
  };

  const connectToMQTTServer = async () => {
    if (!serverUrl && !serverUrlFnc) {
      console.error(
        "MQTT MultiDeviceWhisperer requires either serverUrl or serverUrlFnc",
      );
      return;
    }

    if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    isUnmountedRef.current = false;

    if (clientRef.current) {
      if (clientRef.current.connected) {
        base.setIsReady(true);
        return;
      }
      clientRef.current.removeAllListeners();
      clientRef.current.end(true);
    }

    try {
      const finalUrl = serverUrlFnc ? await serverUrlFnc() : serverUrl;

      if (!finalUrl) throw new Error("Generated MQTT URL was undefined.");

      const options: mqtt.IClientOptions = {
        port: serverPort,
        clientId: clientId,
        username,
        password,
        clean: true,
        keepalive: 30,
        reconnectPeriod: 0, // We now handle this ourselves
      };

      const new_client = mqtt.connect(finalUrl, options);

      new_client.on("connect", () => {
        console.log("MQTT Whisperer Connected");
        base.setIsReady(true);

        // Re-subscribe topic callbacks
        topicCallbacksRef.current.forEach((_callbacks, topic) => {
          new_client.subscribe(topic, { qos: 1 }, (err) => {
            if (err) console.error("Topic callback subscribe failed:", err);
          });
        });

        // Since we create a brand new client on reconnect, we MUST re-subscribe
        // to all actively managed device connections.
        base.connections.forEach((conn) => {
          const topic = subTopicFromUuid?.(conn.uuid) ?? conn.uuid;
          new_client.subscribe(topic, { qos: 1 });
        });
      });

      const handleReconnectCycle = () => {
        base.setIsReady(false);
        if (isUnmountedRef.current) return;

        console.log("MQTT Whisperer closed. Scheduling async reconnect...");

        // Ensure we only queue one reconnect attempt
        if (reconnectTimeoutRef.current)
          clearTimeout(reconnectTimeoutRef.current);

        if (serverAutoConnect || serverConnectOn) {
          reconnectTimeoutRef.current = setTimeout(() => {
            connectToMQTTServer();
          }, 3000); // 3 second backoff
        }
      };

      new_client.on("close", handleReconnectCycle);

      new_client.on("error", (err) => {
        console.error("MQTT Whisperer Error:", err);
        handleReconnectCycle();
      });

      new_client.on("message", (topic, payload) => {
        if (isUnmountedRef.current) return;

        const uuid = uuidFromMessage(topic, payload);
        const bytes =
          payload instanceof Uint8Array ? payload : new Uint8Array(payload);

        const topicCallbacks = topicCallbacksRef.current.get(topic);
        topicCallbacks?.forEach((cb) => {
          try {
            cb(bytes, topic);
          } catch (err) {
            console.error("Topic callback failed:", err);
          }
        });

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

      // If fetching the URL fails, try again in 3 seconds
      if (!isUnmountedRef.current && (serverAutoConnect || serverConnectOn)) {
        reconnectTimeoutRef.current = setTimeout(() => {
          connectToMQTTServer();
        }, 3000);
      }
    }
  };

  const connect = async (uuid: string) => {
    const conn = base.getConnection(uuid);
    if (!clientRef.current || isUnmountedRef.current || !conn) return;

    const topic = subTopicFromUuid?.(uuid) ?? uuid;
    if (clientRef.current.connected && !clientRef.current.disconnecting) {
      clientRef.current.subscribe(topic, { qos: 1 }, async (err) => {
        if (err) console.error("Subscribe failed:", err);
        else {
          console.log("MQTT Subscribed:", topic);
          conn.onConnect?.();
        }
      });
    } else {
      console.warn("Skipped subscribe - client disconnected or unmounted");
    }
  };

  const disconnect = async (uuid: string) => {
    if (!clientRef.current || isUnmountedRef.current) return;

    const topic = subTopicFromUuid?.(uuid) ?? uuid;

    // Keep topic subscribed if callbacks or other device-connections still depend on it.
    if (
      hasCallbackForTopic(topic) ||
      hasOtherConnectionUsingTopic(topic, uuid)
    ) {
      return;
    }

    if (clientRef.current.connected && !clientRef.current.disconnecting) {
      clientRef.current.unsubscribe(topic, async (err) => {
        if (err) console.error("Unsubscribe failed:", err);
        else {
          console.log("MQTT Unsubscribed:", topic);
        }
      });
    } else {
      console.warn("Skipped unsubscribe - client disconnected or unmounted");
    }
  };

  function touchHeartbeat(uuid: string) {
    if (isUnmountedRef.current || !enableWatchdog) return;

    clearTimeout(watchdogTimers.current[uuid]?.ping);
    clearTimeout(watchdogTimers.current[uuid]?.warn);
    clearTimeout(watchdogTimers.current[uuid]?.fail);

    const currentConn = base.getConnection(uuid);

    base.updateConnection(uuid, (c) => ({
      ...c,
      isConnected: true,
      isConnecting: false,
    }));

    const ping = setTimeout(() => {
      if (isUnmountedRef.current) return;
      currentConn?.pingFunction?.();
    }, 25000);

    const warn = setTimeout(() => {
      if (isUnmountedRef.current) return;
      base.updateConnection(uuid, (c) => ({
        ...c,
        isConnected: false,
        isConnecting: true,
      }));
    }, 30000);

    const fail = setTimeout(() => {
      if (isUnmountedRef.current) return;
      base.updateConnection(uuid, (c) => ({
        ...c,
        isConnected: false,
        isConnecting: false,
      }));
    }, 60000);

    watchdogTimers.current[uuid] = { ping, warn, fail };
  }

  const defaultOnReceive = (
    uuid: string,
    data: string | ArrayBuffer | Uint8Array,
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

  const defaultSend = async (uuid: string, data: string | Uint8Array) => {
    const conn = base.getConnection(uuid);
    if (!conn) return;

    const topic = pubTopicFromUuid?.(uuid) ?? subTopicFromUuid?.(uuid) ?? uuid;
    await publish(topic, data, uuid);
  };

  const addConnection = async ({
    uuid,
    propCreator,
  }: AddConnectionProps<AppOrMessageLayer>) => {
    if (!clientRef.current || isUnmountedRef.current) return "";

    if (!uuid) {
      Error(
        "In MQTT you MUST define a UUID otherwise we don't know what device we're connecting to!",
      );
      return "";
    }

    if (
      base.connections.some((c) => c.uuid === uuid) ||
      addingConnections.current.has(uuid)
    ) {
      return "";
    }

    await base.addConnection({
      uuid,
      propCreator: (id) => {
        const props = propCreator?.(id);

        return {
          // Defaults, may be overridden by props
          send: (d) => defaultSend(id, d),
          publish: (topic, payload) => publish(topic, payload, id),
          subscribeCallbackToTopic,
          onReceive: (d) => defaultOnReceive(id, d),
          touchHeartbeat: () => touchHeartbeat(id),
          // Initial connection state
          ...base.createInitialConnectionState(id),
          ...props,
        } as Partial<AppOrMessageLayer>;
      },
    });

    addingConnections.current.delete(uuid);

    // Connect immediately
    const conn = base.getConnection(uuid);
    if (conn?.autoConnect) await connect(uuid);

    return uuid;
  };

  const removeConnection = async (uuid: string) => {
    await disconnect(uuid);
    base.removeConnection(uuid);
  };

  const reconnectAll = async () => {
    const connectionIds = base.connections.map((c) => c.uuid);

    await Promise.all(
      connectionIds.map(async (id) => {
        const c = base.getConnection(id);
        if (!c) return;
        await disconnect(c.uuid);
        await new Promise((res) => setTimeout(res, 250));
        return connect(c.uuid);
      }),
    );
  };

  useEffect(() => {
    if (!(serverAutoConnect || serverConnectOn)) return;

    connectToMQTTServer();

    return () => {
      isUnmountedRef.current = true;
      if (reconnectTimeoutRef.current)
        clearTimeout(reconnectTimeoutRef.current);

      Object.keys(watchdogTimers.current).forEach((uuid) => {
        const timers = watchdogTimers.current[uuid];
        if (timers) {
          clearTimeout(timers.ping);
          clearTimeout(timers.warn);
          clearTimeout(timers.fail);
        }
      });
      watchdogTimers.current = {};

      topicCallbacksRef.current.clear();

      if (clientRef.current) {
        clientRef.current.removeAllListeners();
        clientRef.current.end(true);
      }

      clientRef.current = null;
    };
  }, [serverUrl, serverConnectOn]);

  return {
    ...base,
    addConnection,
    removeConnection,
    connect,
    disconnect,
    reconnectAll,
    connectToMQTTServer,
  };
}
