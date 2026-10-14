// -----------------------------------------------------------------------------
// Between the bus and Gladys. Pure.
//
//   a group telegram of a declared address -> the feature state in Gladys units
//   a Gladys command                       -> the group writes to send
//
// Conventions on both sides:
//   shutter position  KNX 5.001: 0 % = open (up), 100 % = closed (down);
//                     Gladys: 100 = open. `invert` keeps the KNX direction
//                     (and swaps up/down) for actuators set up the other way.
//   contact           KNX 1.019: 1 = open; Gladys opening sensor: 1 = closed.
//                     `invert` for contacts that send 1 when closed.
//   thermostat mode   DPT 20.102 <-> the Gladys presets (see HVAC_TO_PRESET).
// -----------------------------------------------------------------------------

import {
  BINARIES,
  COVER_STATE,
  DEVICE_TYPES,
  FEATURE,
  OPENING,
  SENSORS,
  THERMOSTAT_PRESET,
  factorOf,
} from './devices.js';

/** KNX HVAC mode -> Gladys preset; standby is a short setback, economy the night one. */
export const HVAC_TO_PRESET = {
  auto: THERMOSTAT_PRESET.SCHEDULE,
  comfort: THERMOSTAT_PRESET.COMFORT,
  standby: THERMOSTAT_PRESET.ECO,
  economy: THERMOSTAT_PRESET.NIGHT,
  building_protection: THERMOSTAT_PRESET.FROST,
};
const PRESET_TO_HVAC = {
  ...Object.fromEntries(Object.entries(HVAC_TO_PRESET).map(([mode, preset]) => [preset, mode])),
  [THERMOSTAT_PRESET.AWAY]: 'economy',
};

const tidy = (n, decimals = 3) => Number(n.toFixed(decimals));

/** Every declared address -> the (definition, key) pairs that use it. */
export function listenersOf(definitions) {
  const map = new Map();
  for (const definition of definitions) {
    for (const [key, { ga }] of Object.entries(definition.addresses)) {
      if (!map.has(ga)) {
        map.set(ga, []);
      }
      map.get(ga).push({ definition, key });
    }
  }
  return map;
}

/** The status and sensor addresses of a definition: what is read at start. */
export function readAddresses(definition) {
  const spec = DEVICE_TYPES[definition.type];
  return Object.entries(definition.addresses)
    .filter(([key]) => spec.keys[key].read)
    .map(([, { ga }]) => ga);
}

/**
 * A decoded value of `key` -> { feature, value } in Gladys units, or
 * undefined when the key drives no state (a shutter's move or stop, a
 * position command while a position status address exists).
 */
export function stateOf(definition, key, value) {
  const spec = DEVICE_TYPES[definition.type].keys[key];
  const has = (other) => Boolean(definition.addresses[other]);
  switch (spec.feature) {
    case FEATURE.SWITCH:
    case FEATURE.HEATING:
      return { feature: spec.feature, value: value ? 1 : 0 };
    case FEATURE.BRIGHTNESS:
      if (key === 'brightness' && has('brightness_state')) {
        return undefined;
      }
      return { feature: spec.feature, value };
    case FEATURE.POSITION:
      // The command address only says where the shutter goes: while a status
      // address exists, it alone tells where the shutter is.
      if (key === 'position' && has('position_state')) {
        return undefined;
      }
      return { feature: spec.feature, value: definition.invert ? value : 100 - value };
    case FEATURE.CONTROL:
      return undefined;
    case FEATURE.SETPOINT:
      return { feature: spec.feature, value: tidy(value, 2) };
    case FEATURE.MODE:
      return { feature: spec.feature, value: HVAC_TO_PRESET[value] };
    default:
      break;
  }
  if (definition.type === 'thermostat') {
    return { feature: spec.feature, value: tidy(value, 2) };
  }
  if (SENSORS[key]) {
    const scaled = value * factorOf(key, definition.addresses[key].dpt);
    if (!Number.isFinite(scaled)) {
      return undefined;
    }
    const integer = key === 'counter' || key === 'co2';
    return { feature: key, value: integer ? Math.round(scaled) : tidy(scaled) };
  }
  if (BINARIES[key]) {
    const on = definition.invert ? !value : Boolean(value);
    if (key === 'contact') {
      return { feature: key, value: on ? OPENING.OPEN : OPENING.CLOSED };
    }
    return { feature: key, value: on ? 1 : 0 };
  }
  return undefined;
}

/** Whether a feature is a measurement (published at a calm pace) or a state (at once). */
export const isMeasurement = (definition, feature) =>
  Boolean(SENSORS[feature]) ||
  (definition.type === 'thermostat' && feature === FEATURE.TEMPERATURE);

export class CommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
  }
}

/**
 * A Gladys command on a feature -> the writes to send: [{ key, ga, dpt, value }]
 * with `value` ready for the DPT encoder.
 */
export function commandsOf(definition, feature, rawValue) {
  const value = Number(rawValue);
  const address = (key) => {
    const entry = definition.addresses[key];
    if (!entry) {
      throw new CommandError('no_address', `${definition.name} has no "${key}" address`);
    }
    return { key, ga: entry.ga, dpt: entry.dpt };
  };
  if (!Number.isFinite(value)) {
    throw new CommandError('value', `"${rawValue}" is not a number`);
  }
  switch (feature) {
    case FEATURE.SWITCH:
      return [{ ...address('switch'), value: value ? 1 : 0 }];
    case FEATURE.BRIGHTNESS:
      return [{ ...address('brightness'), value: Math.min(100, Math.max(0, value)) }];
    case FEATURE.CONTROL: {
      if (value === COVER_STATE.STOP) {
        return [{ ...address('stop'), value: 1 }];
      }
      // 1.008: 0 = up (open), 1 = down (close).
      const down = value === COVER_STATE.CLOSE;
      return [{ ...address('move'), value: down !== definition.invert ? 1 : 0 }];
    }
    case FEATURE.POSITION: {
      const position = Math.min(100, Math.max(0, value));
      return [{ ...address('position'), value: definition.invert ? position : 100 - position }];
    }
    case FEATURE.SETPOINT:
      return [{ ...address('setpoint'), value }];
    case FEATURE.MODE: {
      const mode = PRESET_TO_HVAC[value];
      if (!mode) {
        throw new CommandError('value', `preset ${value} has no KNX HVAC mode`);
      }
      return [{ ...address('mode'), value: mode }];
    }
    default:
      throw new CommandError('read_only', `${feature} of ${definition.name} accepts no command`);
  }
}
