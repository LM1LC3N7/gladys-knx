// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized, and
// the grammar of the `devices` field.
//
// KNX has no device discovery: the user lists the devices, one per line or
// separated by commas, each as fields separated by semicolons:
//
//   <type>; <name>; <key>=<group address>[@<dpt>]; ...; [flag]
//
//   light; Living room; switch=1/1/1; state=1/1/2
//   shutter; Bedroom; move=2/1/1; stop=2/1/2; position=2/1/3; position_state=2/1/4; invert
//   sensor; Meter; power=4/1/5@9.024; energy=4/1/6@13.013
//
// Group addresses in three levels (1/2/3), two levels (1/515) or free (2563).
// A line starting with # is a comment. Every mistake is reported with the
// number of its device, and the other devices still work.
// -----------------------------------------------------------------------------

import { ADDRESS_STYLES, KNX_PORT, MAX_DEVICES, PROTOCOLS } from './constants.js';
import { DEVICE_TYPES, KEY_ALIASES, TYPE_ALIASES, dptsOf, slugOf } from './devices.js';
import { parseGroupAddress } from './knx/address.js';

// Defaults: they MUST match the `default` values of the manifest.
export const DEFAULTS = {
  host: '',
  port: KNX_PORT,
  protocol: 'udp',
  devices: '',
  address_style: 'three_level',
  event_addresses: '',
};

/** The codes of the grammar errors (texts in src/i18n.js). */
export const GRAMMAR_ERRORS = {
  TYPE: 'type',
  NAME: 'name',
  KEY: 'key',
  DUPLICATE_KEY: 'duplicate_key',
  ADDRESS: 'address',
  DPT: 'dpt',
  MISSING: 'missing',
  DUPLICATE: 'duplicate',
  TOO_MANY: 'too_many',
};

const NAME_MAX = 60;

const keysOf = (spec) => [...Object.keys(spec.keys), ...spec.flags];

/** One device of the field -> { definition } or { error: { code, detail } }. */
export function parseDeviceEntry(text) {
  const parts = text
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  const word = (parts[0] ?? '').toLowerCase();
  const type = TYPE_ALIASES[word] ?? word;
  const spec = DEVICE_TYPES[type];
  if (!spec) {
    return { error: { code: GRAMMAR_ERRORS.TYPE, detail: parts[0] ?? '' } };
  }
  const name = parts[1] ?? '';
  if (!name || name.includes('=') || name.length > NAME_MAX || !slugOf(name)) {
    return { error: { code: GRAMMAR_ERRORS.NAME, detail: name } };
  }
  const addresses = {};
  let invert = false;
  for (const part of parts.slice(2)) {
    const equal = part.indexOf('=');
    if (equal === -1) {
      const flag = part.toLowerCase();
      if (!spec.flags.includes(flag)) {
        return { error: { code: GRAMMAR_ERRORS.KEY, detail: part, allowed: keysOf(spec) } };
      }
      invert = invert || flag === 'invert';
      continue;
    }
    const written = part.slice(0, equal).trim().toLowerCase();
    const key = KEY_ALIASES[written] ?? written;
    if (!spec.keys[key]) {
      return { error: { code: GRAMMAR_ERRORS.KEY, detail: written, allowed: keysOf(spec) } };
    }
    if (addresses[key]) {
      return { error: { code: GRAMMAR_ERRORS.DUPLICATE_KEY, detail: key } };
    }
    const [addressText, dptText] = part.slice(equal + 1).split('@');
    const parsed = parseGroupAddress(addressText);
    if (parsed.error) {
      return {
        error: { code: GRAMMAR_ERRORS.ADDRESS, detail: addressText.trim(), reason: parsed.error },
      };
    }
    const allowed = dptsOf(type, key);
    let dpt = allowed[0];
    if (dptText !== undefined) {
      const wanted = dptText.trim().replace(/^dpt\s*/i, '');
      if (!allowed.includes(wanted)) {
        return { error: { code: GRAMMAR_ERRORS.DPT, detail: wanted, allowed } };
      }
      dpt = wanted;
    }
    addresses[key] = { ga: parsed.raw, dpt, ...(dptText !== undefined ? { custom: true } : {}) };
  }
  const missing = spec.needs.find((group) => !group.some((key) => addresses[key]));
  if (missing) {
    return { error: { code: GRAMMAR_ERRORS.MISSING, detail: missing.join(' / ') } };
  }
  const slug = slugOf(name);
  return {
    definition: { type, name, slug, id: `${type}:${slug}`, addresses, invert },
  };
}

/**
 * The `devices` field -> { definitions, errors }. Devices are separated by
 * new lines or commas; `index` is the position of the device (1-based,
 * comments and blank entries not counted), the number the errors show.
 */
export function parseDevices(text) {
  const definitions = [];
  const errors = [];
  const seen = new Set();
  const entries = String(text ?? '')
    .split(/[\r\n,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry && !entry.startsWith('#'));
  entries.forEach((entry, i) => {
    const index = i + 1;
    if (definitions.length >= MAX_DEVICES) {
      if (index === MAX_DEVICES + 1) {
        errors.push({ index, code: GRAMMAR_ERRORS.TOO_MANY, detail: String(MAX_DEVICES) });
      }
      return;
    }
    const { definition, error } = parseDeviceEntry(entry);
    if (error) {
      errors.push({ index, ...error });
    } else if (seen.has(definition.id)) {
      errors.push({ index, code: GRAMMAR_ERRORS.DUPLICATE, detail: definition.name });
    } else {
      seen.add(definition.id);
      definitions.push({ index, ...definition });
    }
  });
  return { definitions, errors };
}

/** The `event_addresses` field -> a Set of raw addresses (empty: every address). */
export function parseAddressList(text) {
  const addresses = new Set();
  const invalid = [];
  String(text ?? '')
    .split(/[\s,;]+/)
    .filter(Boolean)
    .forEach((entry) => {
      const parsed = parseGroupAddress(entry);
      if (parsed.error) {
        invalid.push(entry);
      } else {
        addresses.add(parsed.raw);
      }
    });
  return { addresses, invalid };
}

/** "udp://192.168.1.10:3671/" -> { host: '192.168.1.10', port: 3671 } */
function hostOf(raw) {
  let host = typeof raw === 'string' ? raw.trim() : '';
  host = host.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
  const withPort = /^([^:]+):(\d{1,5})$/.exec(host);
  return withPort ? { host: withPort[1], port: Number(withPort[2]) } : { host };
}

const portOf = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
};

export function normalizeConfig(raw = {}) {
  const { host, port: typedPort } = hostOf(raw.host);
  const protocol = String(raw.protocol ?? DEFAULTS.protocol).toLowerCase();
  const style = String(raw.address_style ?? DEFAULTS.address_style);
  const { definitions, errors } = parseDevices(raw.devices);
  const events = parseAddressList(raw.event_addresses);
  return {
    host,
    port: typedPort ?? portOf(raw.port) ?? DEFAULTS.port,
    protocol: PROTOCOLS.includes(protocol) ? protocol : DEFAULTS.protocol,
    definitions,
    errors,
    addressStyle: ADDRESS_STYLES.includes(style) ? style : DEFAULTS.address_style,
    /** undefined: every group address fires the trigger. */
    eventAddresses: events.addresses.size > 0 ? events.addresses : undefined,
    invalidEventAddresses: events.invalid,
  };
}
