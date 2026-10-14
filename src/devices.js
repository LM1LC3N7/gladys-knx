// -----------------------------------------------------------------------------
// The KNX device types, their group address keys and DPTs, and the Gladys
// devices built from them. Pure.
//
// External ids (forever):
//   <type>:<slug of the name>      a device of the `devices` field, e.g.
//                                  light:living-room, shutter:bedroom
//   <device id>:<feature key>      its features (FEATURE below)
// The id comes from the type and the name, never from the position of the
// line: reordering the list changes nothing, renaming a device makes a new
// one (docs: "Renaming a device").
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { formatGroupAddress } from './knx/address.js';

/** Feature keys (the last segment of the feature external ids). Forever. */
export const FEATURE = {
  SWITCH: 'switch',
  BRIGHTNESS: 'brightness',
  CONTROL: 'control',
  POSITION: 'position',
  SETPOINT: 'setpoint',
  MODE: 'mode',
  HEATING: 'heating',
  TEMPERATURE: 'temperature',
};

/** Gladys values of the shutter command and the thermostat presets (core enums). */
export const COVER_STATE = { OPEN: 1, CLOSE: -1, STOP: 0 };
export const THERMOSTAT_PRESET = { SCHEDULE: 0, FROST: 1, AWAY: 2, ECO: 3, NIGHT: 4, COMFORT: 5 };
export const OPENING = { OPEN: 0, CLOSED: 1 };

/**
 * The sensor keys: their DPTs, as [dpt, factor] pairs (the first one is the
 * default; strings, so 9.020 never becomes 9.02), the factor bringing each
 * DPT to the unit of the feature (Wh -> kWh, kW -> W...).
 */
export const SENSORS = {
  temperature: {
    dpts: [
      ['9.001', 1],
      ['14.068', 1],
    ],
    feature: { category: C.TEMPERATURE_SENSOR, type: T.SENSOR.DECIMAL, unit: U.CELSIUS },
    min: -50,
    max: 150,
  },
  humidity: {
    dpts: [
      ['9.007', 1],
      ['5.001', 1],
    ],
    feature: { category: C.HUMIDITY_SENSOR, type: T.SENSOR.DECIMAL, unit: U.PERCENT },
    min: 0,
    max: 100,
  },
  illuminance: {
    dpts: [['9.004', 1]],
    feature: { category: C.LIGHT_SENSOR, type: T.SENSOR.DECIMAL, unit: U.LUX },
    min: 0,
    max: 200000,
  },
  co2: {
    dpts: [['9.008', 1]],
    feature: { category: C.CO2_SENSOR, type: T.SENSOR.INTEGER, unit: U.PPM },
    min: 0,
    max: 10000,
  },
  wind: {
    dpts: [
      ['9.005', 1],
      ['9.028', 1 / 3.6],
    ],
    feature: { category: C.SPEED_SENSOR, type: T.SPEED_SENSOR.DECIMAL, unit: U.METER_PER_SECOND },
    min: 0,
    max: 100,
  },
  pressure: {
    dpts: [
      ['9.006', 0.01],
      ['14.058', 0.01],
    ],
    feature: { category: C.PRESSURE_SENSOR, type: T.SENSOR.DECIMAL, unit: U.HECTO_PASCAL },
    min: 0,
    max: 2000,
  },
  power: {
    dpts: [
      ['14.056', 1],
      ['9.024', 1000],
    ],
    feature: { category: C.ENERGY_SENSOR, type: T.ENERGY_SENSOR.POWER, unit: U.WATT },
    min: -1000000,
    max: 1000000,
  },
  energy: {
    dpts: [
      ['13.010', 0.001],
      ['13.013', 1],
    ],
    feature: { category: C.ENERGY_SENSOR, type: T.ENERGY_SENSOR.INDEX, unit: U.KILOWATT_HOUR },
    min: 0,
    max: 100000000,
  },
  voltage: {
    dpts: [
      ['14.027', 1],
      ['9.020', 0.001],
    ],
    feature: { category: C.ENERGY_SENSOR, type: T.ENERGY_SENSOR.VOLTAGE, unit: U.VOLT },
    min: 0,
    max: 100000,
  },
  current: {
    dpts: [
      ['14.019', 1],
      ['9.021', 0.001],
    ],
    feature: { category: C.ENERGY_SENSOR, type: T.ENERGY_SENSOR.CURRENT, unit: U.AMPERE },
    min: 0,
    max: 100000,
  },
  counter: {
    dpts: [
      ['5.010', 1],
      ['13.001', 1],
    ],
    feature: { category: C.COUNTER_SENSOR, type: T.SENSOR.INTEGER },
    min: 0,
    max: 2147483647,
  },
};

/** The binary sensor keys (DPT 1). `contact` follows 1.019: 1 = open. */
export const BINARIES = {
  contact: { dpt: '1.019', category: C.OPENING_SENSOR },
  motion: { dpt: '1.002', category: C.MOTION_SENSOR },
  presence: { dpt: '1.018', category: C.PRESENCE_SENSOR },
  smoke: { dpt: '1.005', category: C.SMOKE_SENSOR },
  leak: { dpt: '1.005', category: C.LEAK_SENSOR },
};

/** The names of the sensor features in Gladys (the user can rename them). */
const FEATURE_NAMES = {
  temperature: 'Temperature',
  humidity: 'Humidity',
  illuminance: 'Illuminance',
  co2: 'CO2',
  wind: 'Wind speed',
  pressure: 'Pressure',
  power: 'Power',
  energy: 'Energy',
  voltage: 'Voltage',
  current: 'Current',
  counter: 'Counter',
  contact: 'Contact',
  motion: 'Motion',
  presence: 'Presence',
  smoke: 'Smoke',
  leak: 'Leak',
};

const write = (feature, dpt) => ({ feature, dpt, write: true });
const status = (feature, dpt) => ({ feature, dpt, read: true });

/**
 * The device types of the `devices` field (forever: the type is part of the
 * external id). For each key: the feature it drives, its DPT, and whether it
 * is written by commands (`write`) or read at start and followed (`read`).
 * `needs`: at least one key of each group must be there.
 */
export const DEVICE_TYPES = {
  light: {
    keys: {
      switch: write(FEATURE.SWITCH, '1.001'),
      state: status(FEATURE.SWITCH, '1.001'),
    },
    needs: [['switch']],
    flags: [],
  },
  dimmer: {
    keys: {
      switch: write(FEATURE.SWITCH, '1.001'),
      state: status(FEATURE.SWITCH, '1.001'),
      brightness: write(FEATURE.BRIGHTNESS, '5.001'),
      brightness_state: status(FEATURE.BRIGHTNESS, '5.001'),
    },
    needs: [['switch', 'brightness']],
    flags: [],
  },
  shutter: {
    keys: {
      move: write(FEATURE.CONTROL, '1.008'),
      stop: write(FEATURE.CONTROL, '1.017'),
      position: write(FEATURE.POSITION, '5.001'),
      position_state: status(FEATURE.POSITION, '5.001'),
    },
    needs: [['move', 'position']],
    flags: ['invert'],
  },
  switch: {
    keys: {
      switch: write(FEATURE.SWITCH, '1.001'),
      state: status(FEATURE.SWITCH, '1.001'),
    },
    needs: [['switch']],
    flags: [],
  },
  sensor: {
    keys: Object.fromEntries(
      Object.entries(SENSORS).map(([key, s]) => [key, status(key, s.dpts[0][0])]),
    ),
    needs: [Object.keys(SENSORS)],
    flags: [],
  },
  thermostat: {
    keys: {
      setpoint: write(FEATURE.SETPOINT, '9.001'),
      setpoint_state: status(FEATURE.SETPOINT, '9.001'),
      temperature: status(FEATURE.TEMPERATURE, '9.001'),
      mode: write(FEATURE.MODE, '20.102'),
      mode_state: status(FEATURE.MODE, '20.102'),
      heating: status(FEATURE.HEATING, '1.001'),
    },
    needs: [['setpoint', 'setpoint_state', 'temperature', 'mode', 'mode_state']],
    flags: [],
  },
  binary: {
    keys: Object.fromEntries(Object.entries(BINARIES).map(([key, b]) => [key, status(key, b.dpt)])),
    needs: [Object.keys(BINARIES)],
    flags: ['invert'],
  },
};

/** Other words accepted in the field. */
export const TYPE_ALIASES = { blind: 'shutter', cover: 'shutter', lamp: 'light' };
export const KEY_ALIASES = { lux: 'illuminance', brightness_status: 'brightness_state' };

/** The DPTs a key accepts (`@` in the field): only sensors offer a choice. */
export function dptsOf(type, key) {
  if (type === 'sensor') {
    return SENSORS[key].dpts.map(([dpt]) => dpt);
  }
  return [DEVICE_TYPES[type].keys[key].dpt];
}

/** The factor bringing a sensor DPT to the unit of its feature. */
export const factorOf = (key, dpt) => SENSORS[key].dpts.find(([d]) => d === dpt)?.[1] ?? 1;

/** "Living room" -> "living-room" (accents and symbols dropped). Forever. */
export function slugOf(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

export const ids = {
  device: (gladys, definition) => gladys.externalId(definition.id),
  feature: (deviceId, key) => `${deviceId}:${key}`,
};

const TYPE_PATTERN = Object.keys(DEVICE_TYPES).join('|');
const EXTERNAL_ID = new RegExp(`^ext:[^:]+:(${TYPE_PATTERN}):([a-z0-9-]+)$`);

/** A device external id -> { type, slug, id } (id as in the definitions), or undefined. */
export function parseExternalId(externalId) {
  const match = EXTERNAL_ID.exec(String(externalId ?? ''));
  return match ? { type: match[1], slug: match[2], id: `${match[1]}:${match[2]}` } : undefined;
}

/** The features a definition gets (each feature once, whatever its keys). */
export function featureKeysOf(definition) {
  const keys = new Set();
  const { keys: catalog } = DEVICE_TYPES[definition.type];
  for (const key of Object.keys(definition.addresses)) {
    keys.add(catalog[key].feature);
  }
  // The shutter command needs an up/down address; `stop` alone is no command.
  if (definition.type === 'shutter' && !definition.addresses.move) {
    keys.delete(FEATURE.CONTROL);
  }
  return [...keys];
}

/** Whether a feature of a definition is written by commands. */
const writable = (definition, featureKey) =>
  Object.keys(definition.addresses).some((key) => {
    const spec = DEVICE_TYPES[definition.type].keys[key];
    return spec.feature === featureKey && spec.write === true;
  });

/** Whether a feature also gets a status address (Gladys then waits for the feedback). */
const fedBack = (definition, featureKey) =>
  Object.keys(definition.addresses).some(
    (key) =>
      DEVICE_TYPES[definition.type].keys[key].feature === featureKey &&
      DEVICE_TYPES[definition.type].keys[key].read === true,
  );

const base = (deviceId, key, name, category, type, extra = {}) => ({
  name,
  external_id: ids.feature(deviceId, key),
  category,
  type,
  min: 0,
  max: 1,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...extra,
});

const PRESET_OPTIONS = [
  { value: THERMOSTAT_PRESET.SCHEDULE, label: { en: 'Auto', fr: 'Auto' }, sort_order: 0 },
  { value: THERMOSTAT_PRESET.COMFORT, label: { en: 'Comfort', fr: 'Confort' }, sort_order: 1 },
  { value: THERMOSTAT_PRESET.ECO, label: { en: 'Standby', fr: 'Veille' }, sort_order: 2 },
  { value: THERMOSTAT_PRESET.NIGHT, label: { en: 'Economy', fr: 'Économie' }, sort_order: 3 },
  {
    value: THERMOSTAT_PRESET.FROST,
    label: { en: 'Building protection', fr: 'Protection hors-gel' },
    sort_order: 4,
  },
];

function featureOf(definition, deviceId, key) {
  const command = writable(definition, key);
  const control = {
    read_only: !command,
    has_feedback: command && fedBack(definition, key),
  };
  switch (key) {
    case FEATURE.SWITCH:
      return definition.type === 'switch'
        ? base(deviceId, key, 'Switch', C.SWITCH, T.SWITCH.BINARY, control)
        : base(deviceId, key, 'Light', C.LIGHT, T.LIGHT.BINARY, control);
    case FEATURE.BRIGHTNESS:
      // No unit: the core lists none for the light and shutter categories.
      return base(deviceId, key, 'Brightness', C.LIGHT, T.LIGHT.BRIGHTNESS, {
        ...control,
        max: 100,
      });
    case FEATURE.CONTROL:
      return base(deviceId, key, 'Shutter', C.SHUTTER, T.SHUTTER.STATE, {
        min: COVER_STATE.CLOSE,
        max: COVER_STATE.OPEN,
        read_only: false,
        keep_history: false,
      });
    case FEATURE.POSITION:
      return base(deviceId, key, 'Position', C.SHUTTER, T.SHUTTER.POSITION, {
        ...control,
        max: 100,
      });
    case FEATURE.SETPOINT:
      return base(deviceId, key, 'Setpoint', C.THERMOSTAT, T.THERMOSTAT.TARGET_TEMPERATURE, {
        ...control,
        min: 5,
        max: 35,
        unit: U.CELSIUS,
      });
    case FEATURE.MODE:
      return base(deviceId, key, 'Mode', C.THERMOSTAT, T.THERMOSTAT.PRESET, {
        ...control,
        max: THERMOSTAT_PRESET.COMFORT,
        keep_history: false,
        supported_options: PRESET_OPTIONS,
      });
    case FEATURE.HEATING:
      return base(deviceId, key, 'Heating', C.THERMOSTAT, T.THERMOSTAT.OPERATING_STATE, {
        keep_history: false,
      });
    case FEATURE.TEMPERATURE:
      if (definition.type === 'thermostat') {
        return base(deviceId, key, 'Temperature', C.TEMPERATURE_SENSOR, T.SENSOR.DECIMAL, {
          unit: U.CELSIUS,
          min: -50,
          max: 150,
        });
      }
      break;
    default:
      break;
  }
  if (SENSORS[key]) {
    const sensor = SENSORS[key];
    return base(deviceId, key, FEATURE_NAMES[key], sensor.feature.category, sensor.feature.type, {
      ...(sensor.feature.unit ? { unit: sensor.feature.unit } : {}),
      min: sensor.min,
      max: sensor.max,
    });
  }
  return base(deviceId, key, FEATURE_NAMES[key], BINARIES[key].category, T.SENSOR.BINARY);
}

/** "switch=1/1/1, state=1/1/2" (the device params show the addresses). */
export function addressSummary(definition, style) {
  return Object.entries(definition.addresses)
    .map(([key, { ga, dpt, custom }]) => {
      const text = `${key}=${formatGroupAddress(ga, style)}`;
      return custom ? `${text}@${dpt}` : text;
    })
    .join(', ');
}

/** The Gladys device of a definition. */
export function buildDevice(gladys, definition, style) {
  const id = ids.device(gladys, definition);
  return {
    name: definition.name,
    external_id: id,
    features: featureKeysOf(definition).map((key) => featureOf(definition, id, key)),
    params: [
      { name: 'type', value: definition.type },
      { name: 'addresses', value: addressSummary(definition, style) },
      ...(definition.invert ? [{ name: 'invert', value: 'true' }] : []),
    ],
  };
}
