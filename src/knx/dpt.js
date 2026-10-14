// -----------------------------------------------------------------------------
// KNX datapoint types (KNX 03.07.02 Datapoint Types). Pure.
//
// A group value travels in one of two shapes (KNX 03.03.07 Application Layer):
//   small  up to 6 bits packed into the APCI octet (DPT 1, 2, 3)
//   data   whole octets after the APCI (every other DPT)
// Here a payload is { small: true, value } or { small: false, data: Buffer }.
//
// The encodings follow the specification as implemented by xknx (the expected
// bytes of test/dpt.test.js come from its test suite), including Python's
// round-half-to-even wherever xknx calls round().
// -----------------------------------------------------------------------------

export class DptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DptError';
  }
}

export const small = (value) => ({ small: true, value: value & 0x3f });
export const data = (bytes) => ({ small: false, data: Buffer.from(bytes) });

/** Python's round(): halves go to the even neighbour (0.5 -> 0, 1.5 -> 2). */
export function roundHalfEven(x) {
  if (Math.abs(x % 1) === 0.5) {
    return 2 * Math.round(x / 2);
  }
  return Math.round(x);
}

/** The payload as hex ("0c1a"; a small value is its own octet: "01"). */
export function payloadHex(payload) {
  if (!payload) {
    return '';
  }
  return payload.small
    ? payload.value.toString(16).padStart(2, '0')
    : Buffer.from(payload.data).toString('hex');
}

const bytesOf = (payload, length, dpt) => {
  if (!payload || payload.small || payload.data.length !== length) {
    throw new DptError(`DPT ${dpt} expects ${length} octet(s)`);
  }
  return payload.data;
};

const bitsOf = (payload, dpt) => {
  if (payload?.small) {
    return payload.value;
  }
  // Tolerated: some devices send a short value in a whole octet.
  if (payload && payload.data.length === 1) {
    return payload.data[0];
  }
  throw new DptError(`DPT ${dpt} expects a small value`);
};

const finite = (value, dpt) => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new DptError(`DPT ${dpt}: "${value}" is not a number`);
  }
  return n;
};

const inRange = (n, min, max, dpt) => {
  if (n < min || n > max) {
    throw new DptError(`DPT ${dpt}: ${n} is out of range ${min}..${max}`);
  }
  return n;
};

// --- DPT 1: one bit ------------------------------------------------------------

const dpt1 = {
  decode: (payload) => bitsOf(payload, '1') & 0x01,
  encode: (value) => small(value === true || Number(value) === 1 ? 1 : 0),
};

// --- DPT 3.007: dimming step (4 bits) ------------------------------------------
// bit 3: 1 increase / 0 decrease; bits 0-2: the step code, 0 = stop (break).

const dpt3 = {
  decode: (payload) => {
    const raw = bitsOf(payload, '3') & 0x0f;
    return { increase: Boolean(raw & 0x08), step: raw & 0x07 };
  },
  encode: ({ increase, step }) => {
    inRange(step, 0, 7, '3');
    return small(((increase ? 1 : 0) << 3) | step);
  },
};

// --- DPT 5: one octet ------------------------------------------------------------

const dpt5 = {
  decode: (payload) => bytesOf(payload, 1, '5')[0],
  encode: (value) => data([inRange(Math.trunc(finite(value, '5')), 0, 255, '5')]),
};

/** 5.001 scaling: 0-100 % on 0-255. */
const dpt5001 = {
  decode: (payload) => roundHalfEven((bytesOf(payload, 1, '5.001')[0] / 255) * 100),
  encode: (value) => {
    const percent = inRange(finite(value, '5.001'), 0, 100, '5.001');
    return data([roundHalfEven((percent / 100) * 255)]);
  },
};

// --- DPT 9: two-octet float ------------------------------------------------------
// MEEEEMMM MMMMMMMM: value = 0.01 * M * 2^E, M a 12-bit two's complement.
// 7FFFh is "invalid data" (03.07.02 §3.10), hence the maximum 670433.28.

const DPT9_MIN = -671088.64;
const DPT9_MAX = 670433.28;

const dpt9 = {
  decode: (payload) => {
    const [high, low] = bytesOf(payload, 2, '9');
    if (high === 0x7f && low === 0xff) {
      throw new DptError('DPT 9: invalid data (7FFFh)');
    }
    const raw = (high << 8) | low;
    const exponent = (raw >> 11) & 0x0f;
    let significand = raw & 0x7ff;
    if (raw >> 15) {
      significand -= 2048;
    }
    return (significand << exponent) / 100;
  },
  encode: (value) => {
    const n = inRange(finite(value, '9'), DPT9_MIN, DPT9_MAX, '9');
    let knx = n * 100;
    // ETS turns the values near zero into 0000h, never into 8000h (= -20.48).
    if (roundHalfEven(knx) === 0) {
      return data([0, 0]);
    }
    let exponent = 0;
    while (knx < -2048 || knx > 2047) {
      exponent += 1;
      knx /= 2;
    }
    let mantissa = roundHalfEven(knx);
    // 2047.5 rounds up to 2048, which does not fit in 11 bits: take one more
    // exponent step (xknx would wrap it to 0 here).
    if (mantissa > 2047) {
      exponent += 1;
      knx /= 2;
      mantissa = roundHalfEven(knx);
    }
    const bits = mantissa & 0x7ff;
    let high = (exponent << 3) | (bits >> 8);
    if (knx < 0) {
      high |= 0x80;
    }
    return data([high, bits & 0xff]);
  },
};

// --- DPT 13: four-octet signed ------------------------------------------------------

const dpt13 = {
  decode: (payload) => bytesOf(payload, 4, '13').readInt32BE(0),
  encode: (value) => {
    const n = inRange(Math.trunc(finite(value, '13')), -2147483648, 2147483647, '13');
    const buffer = Buffer.alloc(4);
    buffer.writeInt32BE(n, 0);
    return data(buffer);
  },
};

// --- DPT 14: four-octet IEEE 754 float ------------------------------------------------

/**
 * Seven significant digits, as the ETS group monitor shows them (and xknx):
 * a float32 read back as a double is 21.5 or 0.9450001, not 0.94500005245.
 */
export function round7(x) {
  if (x === 0 || !Number.isFinite(x)) {
    return x;
  }
  const digits = 7 - Math.ceil(Math.log10(Math.abs(x)));
  if (digits >= 0) {
    return Number(x.toFixed(Math.min(digits, 100)));
  }
  const scale = 10 ** -digits;
  return roundHalfEven(x / scale) * scale;
}

const dpt14 = {
  decode: (payload) => round7(bytesOf(payload, 4, '14').readFloatBE(0)),
  encode: (value) => {
    const buffer = Buffer.alloc(4);
    buffer.writeFloatBE(finite(value, '14'), 0);
    return data(buffer);
  },
};

// --- DPT 17.001 scene number, 18.001 scene control ------------------------------------
// On the wire the scene is 0-63; users (and ETS) count 1-64.

const dpt17 = {
  decode: (payload) => {
    const raw = bytesOf(payload, 1, '17.001')[0];
    if (raw > 63) {
      throw new DptError(`DPT 17.001: ${raw} is not a scene`);
    }
    return raw + 1;
  },
  encode: (value) => data([inRange(Math.trunc(finite(value, '17.001')), 1, 64, '17.001') - 1]),
};

/** bit 7: learn (1) or activate (0); bits 0-5: the scene number - 1. */
const dpt18 = {
  decode: (payload) => {
    const raw = bytesOf(payload, 1, '18.001')[0];
    return { learn: Boolean(raw & 0x80), scene: (raw & 0x3f) + 1 };
  },
  encode: ({ learn = false, scene }) => {
    const n = inRange(Math.trunc(finite(scene, '18.001')), 1, 64, '18.001');
    return data([(learn ? 0x80 : 0) | (n - 1)]);
  },
};

// --- DPT 20.102 HVAC mode ------------------------------------------------------------------

export const HVAC_MODES = ['auto', 'comfort', 'standby', 'economy', 'building_protection'];

const dpt20102 = {
  decode: (payload) => {
    const raw = bytesOf(payload, 1, '20.102')[0];
    if (raw >= HVAC_MODES.length) {
      throw new DptError(`DPT 20.102: ${raw} is not an HVAC mode`);
    }
    return HVAC_MODES[raw];
  },
  encode: (value) => {
    const index = typeof value === 'number' ? value : HVAC_MODES.indexOf(value);
    if (!Number.isInteger(index) || index < 0 || index >= HVAC_MODES.length) {
      throw new DptError(`DPT 20.102: "${value}" is not an HVAC mode`);
    }
    return data([index]);
  },
};

// --- Registry --------------------------------------------------------------------------------

const CODECS = {
  1: dpt1,
  3: dpt3,
  5: dpt5,
  5.001: dpt5001,
  9: dpt9,
  13: dpt13,
  14: dpt14,
  17: dpt17,
  18: dpt18,
  20.102: dpt20102,
};

function codecOf(dpt) {
  const id = String(dpt);
  const codec = CODECS[id] ?? CODECS[id.split('.')[0]];
  if (!codec) {
    throw new DptError(`DPT ${id} is not supported`);
  }
  return codec;
}

/** Whether a DPT travels as a small (6-bit) value. */
export const isSmallDpt = (dpt) => ['1', '2', '3'].includes(String(dpt).split('.')[0]);

/** Payload -> value (number, string or { increase, step } / { learn, scene }). */
export const decode = (dpt, payload) => codecOf(dpt).decode(payload);

/** Value -> payload. */
export const encode = (dpt, value) => codecOf(dpt).encode(value);

/** A decoded value as a trigger text, the same for every scene ("1", "21.5", "comfort"). */
export function valueText(dpt, value) {
  const main = String(dpt).split('.')[0];
  if (main === '3') {
    return value.step === 0 ? 'stop' : `${value.increase ? '+' : '-'}${value.step}`;
  }
  if (main === '18') {
    return value.learn ? `learn ${value.scene}` : String(value.scene);
  }
  return String(value);
}

/** A decoded value as a number when it has one (an HVAC mode is its index). */
export function valueNumber(dpt, value) {
  const main = String(dpt).split('.')[0];
  if (main === '3') {
    return value.increase ? value.step : -value.step;
  }
  if (main === '18') {
    return value.scene;
  }
  if (main === '20') {
    return HVAC_MODES.indexOf(value);
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// --- Text typed in a scene action -> value ------------------------------------------------

const ON = ['1', 'on', 'true', 'yes', 'oui', 'down', 'close', 'closed', 'increase'];
const OFF = ['0', 'off', 'false', 'no', 'non', 'up', 'open', 'decrease'];

/**
 * Parse the value of the "send group value" action for a DPT option of the
 * manifest. Throws a DptError the action shows as is.
 */
export function parseValue(dpt, text) {
  const value = String(text ?? '')
    .trim()
    .toLowerCase();
  switch (String(dpt)) {
    case '1':
      if (ON.includes(value)) {
        return 1;
      }
      if (OFF.includes(value)) {
        return 0;
      }
      throw new DptError(`DPT 1: "${text}" is neither 1/on nor 0/off`);
    case '3.007': {
      if (value === 'stop' || value === '0') {
        return { increase: false, step: 0 };
      }
      const match = /^([+-])\s*([1-7])?$/.exec(value);
      if (!match) {
        throw new DptError(`DPT 3.007: "${text}" is not +1..+7, -1..-7 or stop`);
      }
      return { increase: match[1] === '+', step: Number(match[2] ?? 1) };
    }
    case '18.001': {
      const match = /^(learn\s*:?\s*)?(\d{1,2})$/.exec(value);
      if (!match) {
        throw new DptError(`DPT 18.001: "${text}" is not a scene (5, or "learn 5")`);
      }
      return { learn: Boolean(match[1]), scene: Number(match[2]) };
    }
    case '20.102': {
      const aliases = { frost: 'building_protection', protection: 'building_protection' };
      const word = aliases[value] ?? value.replace(/[\s-]+/g, '_');
      if (HVAC_MODES.includes(word)) {
        return word;
      }
      if (/^[0-4]$/.test(word)) {
        return HVAC_MODES[Number(word)];
      }
      throw new DptError(`DPT 20.102: "${text}" is not ${HVAC_MODES.join(', ')}`);
    }
    default:
      return finite(value, dpt);
  }
}

/** Raw hex typed in the action ("0c 1a", "0x0C1A") -> payload of whole octets. */
export function parseHex(text) {
  const hex = String(text ?? '')
    .replace(/0x/gi, '')
    .replace(/[\s:,-]+/g, '');
  if (!/^([0-9a-f]{2}){1,14}$/i.test(hex)) {
    throw new DptError(`"${text}" is not 1 to 14 octets of hex`);
  }
  return data(Buffer.from(hex, 'hex'));
}
