// -----------------------------------------------------------------------------
// Constants of the KNX integration.
// -----------------------------------------------------------------------------

/** The KNXnet/IP port (control endpoint of every gateway). */
export const KNX_PORT = 3671;
export const PROTOCOLS = ['udp', 'tcp'];

/**
 * KNXnet/IP timings: KNX 03.08.02 Core §5.4 and 03.08.04 Tunnelling §2.6, as
 * xknx implements them (CONNECT 10 s, CONNECTIONSTATE every 60 s with 10 s to
 * answer, TUNNELLING_ACK 1 s, L_Data.con 3 s).
 */
export const TIMING = {
  CONNECT_TIMEOUT: 10_000,
  DESCRIPTION_TIMEOUT: 3_000,
  HEARTBEAT_INTERVAL: 60_000,
  CONNECTIONSTATE_TIMEOUT: 10_000,
  HEARTBEAT_FAILURES: 3,
  ACK_TIMEOUT: 1_000,
  CONFIRM_TIMEOUT: 3_000,
  DISCONNECT_TIMEOUT: 1_000,
  /** An unexpected sequence counter must be followed by the expected one within. */
  SEQUENCE_GRACE: 2_000,
};

/**
 * Be gentle with the bus (TP1 carries 20 to 50 telegrams a second at best,
 * shared with every device of the house) and with Gladys (300 states and 300
 * scene events a minute per integration).
 */
export const PACING = {
  /** Pause after each telegram we send: a write, a read. */
  WRITE_SPACING: 100,
  READ_SPACING: 250,
  /** Telegrams waiting to be sent at most (a scene loop cannot flood the bus). */
  QUEUE_LIMIT: 200,
  /** Reconnection: 2 s doubling up to a minute; a minute when every tunnel is taken. */
  RECONNECT_BASE: 2_000,
  RECONNECT_MAX: 60_000,
  RECONNECT_BUSY: 60_000,
  /** A measurement (temperature, power...) reaches Gladys at most every 30 s. */
  SENSOR_STATE_INTERVAL: 30_000,
  /** An unchanged state is sent again every 30 minutes. */
  STATE_HEARTBEAT: 30 * 60_000,
  /** The same telegram again within 1 s (a bus repetition) fires no second event. */
  DUPLICATE_WINDOW: 1_000,
  /** Scene events per minute at most (the core accepts 300). */
  EVENTS_PER_MINUTE: 120,
  /** The bus monitor widget is nudged at most every 10 s (the core's own limit). */
  WIDGET_REFRESH: 10_000,
};

/** Telegrams kept for the bus monitor widget. */
export const MONITOR_SIZE = 20;
/** Devices of the `devices` field at most. */
export const MAX_DEVICES = 250;

/** How group addresses are written in events, the widget and the logs. */
export const ADDRESS_STYLES = ['three_level', 'two_level', 'free'];

/** The DPT options of the "send a group value" action (forever: stored in scenes). */
export const SEND_DPTS = [
  '1',
  '3.007',
  '5.001',
  '5.010',
  '9',
  '13',
  '14',
  '17.001',
  '18.001',
  '20.102',
  'raw',
];

/** Manifest keys (forever: stored in user scenes and dashboards). */
export const ACTIONS = { TEST: 'test_gateway' };
export const SCENE_TRIGGERS = { GROUP_VALUE: 'group_value_received' };
export const SCENE_ACTIONS = { SEND: 'send_group_value' };
export const WIDGETS = { BUS: 'bus_monitor' };

/** The keys of the group_value_received event (fields and variables). */
export const EVENT_KEYS = [
  'group_address',
  'device',
  'device_name',
  'value',
  'number',
  'raw',
  'dpt',
  'source',
];
