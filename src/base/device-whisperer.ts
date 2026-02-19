/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from "react";

/*
┌────────────────────────────────┐
│ > Device Whisperer (Generic)   │ (connect/disconnect, state mgmt) - "Abstraction Layer"
├────────────────────────────────┤
│   Serial Device Whisperer      │ (port selection, stream handling) - "Transport Layer"
├────────────────────────────────┤
│   Protobuf Device Whisperer    │ (encoders, decoders, topic routing) - "Message Layer"
├────────────────────────────────┤
│   Enhanced Device Whisperer    │ (e.g. custom fields, handlers) - "Application Layer"
└────────────────────────────────┘
*/

/* Logging Types */
export type LogMessage = string | number | boolean | Record<string, any> | any[];
export type LogLine = {
  level: number;
  message: LogMessage;
  timestamp?: Date;
};

type PropCreatorProps<T> = (uuid: string) => Partial<T> | undefined;
export interface AddConnectionProps<T> { uuid?: string, propCreator?: PropCreatorProps<T> };

export type DeviceConnectionState = {
  // Device info
  uuid: string;
  deviceMac?: string;
  name: string;
  // Comms
  send: (data: string | Uint8Array) => void | Promise<void>;
  onReceive?: (data: string | Uint8Array) => void;
  onConnect?: () => void | Promise<void>;
  onDisconnect?: () => void | Promise<void>;
  // Connection state
  autoConnect: boolean;
  isConnected: boolean;
  isConnecting: boolean;
  logs: LogLine[];
  readBufferLeftover: string;
  readBufferLeftoverAsBytes: Uint8Array;
}

// Initial, generic state for the generic device
export function createDefaultInitialDeviceState<T extends DeviceConnectionState>(
  uuid: string,
  props?: any
): T {
  return {
    uuid,
    autoConnect: true,
    isConnected: false,
    isConnecting: false,
    logs: [],
    readBufferLeftover: "",
    readBufferLeftoverAsBytes: new Uint8Array([]),
    ...props
  };
}

export type DeviceWhispererProps<T extends DeviceConnectionState> = {
  createInitialConnectionState?: (
    uuid: string,
  ) => Partial<T>;
};

/* One Device Whisperer is used for all like-devices, such as all Serial with Protobuf.
   Any e.g. Serial without Protobuf, or LoRaWAN etc. devices would be handled via a separate device whisperer
*/
export function MultiDeviceWhisperer<T extends DeviceConnectionState>(
  {
    createInitialConnectionState = createDefaultInitialDeviceState as (uuid: string) => Partial<T>,
  }: DeviceWhispererProps<T> = {}
) {
  const [connections, setConnections] = useState<T[]>([]);
  const connectionsRef = useRef<Map<string, T>>(new Map());
  const [isReady, setIsReady] = useState<boolean>(false);


  // ---------- GET ----------
  const getConnection = (uuid: string) => connectionsRef.current.get(uuid);

  // ---------- UPDATE ----------
  const updateConnection = (uuid: string, updater: (c: T) => T) => {
    const current = connectionsRef.current.get(uuid);
    if (!current) return;

    const next = updater(current);
    connectionsRef.current.set(uuid, next);
    setConnections(Array.from(connectionsRef.current.values()));
  };

  const updateConnectionName = (uuid: string, name: string) => {
    updateConnection(uuid, (c) => ({ ...c, name }));
  };

  const appendLog = (uuid: string, log: LogLine) => {
    if (!log.timestamp) log.timestamp = new Date();
    updateConnection(uuid, (c) => ({
      ...c,
      logs: [...c.logs.slice(-199), log],
    }));
  };

  // ---------- ADD ----------
  const addConnection = async ({ uuid, propCreator }: AddConnectionProps<T>) => {
    uuid = uuid ?? `unnamed_device_${connectionsRef.current.size}`;
    const props = propCreator?.(uuid);

    const newConnection: T = {
      ...createDefaultInitialDeviceState(uuid),
      ...createInitialConnectionState(uuid),
      ...props
    };

    connectionsRef.current.set(uuid, newConnection);
    setConnections(Array.from(connectionsRef.current.values()));

    return uuid;
  };

  // ---------- REMOVE ----------
  const removeConnection = (uuid: string) => {
    connectionsRef.current.delete(uuid);
    setConnections(Array.from(connectionsRef.current.values()));
  };

  // ---------- EFFECT ----------
  useEffect(() => {
    // initial snapshot
    setConnections(Array.from(connectionsRef.current.values()));
  }, []);

  return {
    connections,
    addConnection,
    removeConnection,
    connect: (_uuid: string) => { },
    disconnect: (_uuid: string) => { },
    updateConnection,
    reconnectAll: () => { },
    updateConnectionName,
    getConnection,
    appendLog,
    isReady,
    setIsReady,
    createInitialConnectionState
  };
}
