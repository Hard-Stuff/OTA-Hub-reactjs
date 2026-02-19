import { useEffect } from "react";
import { DeviceConnectionState, MultiDeviceWhisperer, AddConnectionProps } from "../base/device-whisperer.js";

/*
┌────────────────────────────────┐
│   Device Whisperer (Generic)   │ (connect/disconnect, state mgmt) - "Abstraction Layer"
├────────────────────────────────┤
│ > Websocket Device Whisperer   │ (device URL routing, stream handling) - "Transport Layer"
├────────────────────────────────┤
│   Protobuf Device Whisperer    │ (encoders, decoders, topic routing) - "Message Layer"
├────────────────────────────────┤
│   Enhanced Device Whisperer    │ (e.g. custom fields, handlers) - "Application Layer"
└────────────────────────────────┘
*/

export type WebsocketConnectionState = DeviceConnectionState & {
  ws?: WebSocket;
};

export type DeviceObjectResponse = {
  id: string;
  deviceState: string;
  uiState: string;
  deviceConnectedTime: Date | null;
  deviceLastCommTime: Date | null;
}

export function WebsocketMultiDeviceWhisperer<
  AppOrMessageLayer extends WebsocketConnectionState
>(
  {
    server_url,
    server_port,
    ...props
  }: {
    server_url: string,
    server_port: number,
  }
) {

  const base = MultiDeviceWhisperer<AppOrMessageLayer>(props);

  const defaultOnReceive = (
    uuid: string,
    data: string | ArrayBuffer | Uint8Array
  ) => {
    const conn = base.getConnection(uuid);
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
    const lines = combined.split(/\r?\n/);

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

  const defaultSend = async (
    uuid: string,
    data: string | Uint8Array
  ) => {
    const conn = base.getConnection(uuid);
    if (!conn || !conn.ws) return;

    const asString =
      typeof data === "string"
        ? data
        : btoa(String.fromCharCode(...data));

    base.appendLog(uuid, {
      level: 3,
      message: asString,
    });

    conn.ws.send(data);
  };

  const connect = async (uuid: string, attempt = 0) => {
    const MAX_RETRIES = 5;
    const RETRY_DELAY_MS = 2000; // 2 seconds

    const conn = base.getConnection(uuid);
    if (!conn) return;

    if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
      console.log(`[client] Closing existing WS before reconnect for ${uuid}`);
      conn.ws.close();
    }

    base.updateConnection(uuid, (c) => ({ ...c, isConnecting: true, autoConnect: true }));

    try {
      const pre = server_port !== 443 ? "ws" : "wss";
      const ws = new WebSocket(`${pre}://${server_url}:${server_port}/ui/${uuid}`);
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        base.updateConnection(uuid, (c) => ({
          ...c,
          ws,
          isConnected: true,
          isConnecting: false,
          lastAttempt: attempt
        }));

        base.appendLog(uuid, {
          level: 2,
          message: "[✓] WebSocket connected"
        });

        conn?.onConnect?.();
      };

      ws.onmessage = (event) => {
        let data: string | Uint8Array;
        if (typeof event.data === "string") data = event.data;
        else if (event.data instanceof ArrayBuffer) data = new Uint8Array(event.data);
        else data = event.data as any;
        conn.onReceive?.(data);
      };

      ws.onerror = (err) => {
        base.appendLog(uuid, {
          level: 0,
          message: `[x] WS error: ${err}`
        });
      };

      ws.onclose = async () => {
        base.updateConnection(uuid, (c) => ({
          ...c,
          isConnected: false,
          isConnecting: false,
          ws: undefined
        }));
        base.appendLog(uuid, { level: 0, message: "[!] WS disconnected" });

        const updated_conn = base.getConnection(uuid);
        if (!updated_conn) {
          base.appendLog(uuid, { level: 0, message: "[!] Connection lost!" });
          return;
        }

        // Auto reconnect if enabled
        if (updated_conn.autoConnect && attempt < MAX_RETRIES) {
          base.appendLog(uuid, { level: 2, message: `[~] Reconnecting in ${RETRY_DELAY_MS}ms... (attempt ${attempt + 1})` });
          setTimeout(() => connect(uuid, attempt + 1), RETRY_DELAY_MS);
        }
      };
    } catch (err: any) {
      base.updateConnection(uuid, (c) => ({
        ...c,
        isConnected: false,
        isConnecting: false,
        logs: [
          ...c.logs,
          { level: 0, message: `[x] WS connection error: ${err?.message || "Unknown error"}` }
        ]
      }));
      await disconnect(uuid);
    }
  };

  const disconnect = async (uuid: string) => {
    const conn = base.getConnection(uuid);
    if (!conn?.ws) return;
    base.updateConnection(uuid, (c) => ({
      ...c,
      isConnected: false,
      isConnecting: false,
      autoConnect: false,
      ws: undefined,
      readBufferLeftover: ""
    }));

    conn.ws.close();

    await conn?.onDisconnect?.();
  };

  const addConnection = async (
    { uuid, propCreator }: AddConnectionProps<AppOrMessageLayer>
  ) => {
    return await base.addConnection({
      uuid,
      propCreator: (id) => {
        const props = propCreator?.(id);
        return {
          send: props?.send || ((d) => defaultSend(id, d)),
          onReceive: props?.onReceive || ((d) => defaultOnReceive(id, d)),
          ...props
        } as Partial<AppOrMessageLayer>;
      }
    });
  };

  const removeConnection = async (uuid: string) => {
    await disconnect(uuid);
    base.removeConnection(uuid);
  };

  const checkForNewDevices = async () => {
    try {
      const url =
        server_port !== 443
          ? `http://${server_url}:${server_port}`
          : `https://${server_url}`;
      const response = await fetch(`${url}/devices`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return (await response.json()) as DeviceObjectResponse[];
    } catch (error) {
      console.error("Failed to fetch devices:", error);
      return [];
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

  useEffect(() => {
    base.setIsReady(true) // Ready on page load by default
  }, [])

  return {
    ...base,
    addConnection,
    removeConnection,
    connect,
    disconnect,
    checkForNewDevices,
    reconnectAll
  };
}
