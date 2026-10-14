// -----------------------------------------------------------------------------
// KNX addresses. Pure.
//
// A group address is 16 bits on the wire (KNX 03.03.02 Network Layer), shown
// in three styles that all mean the same raw value:
//   three levels  main/middle/sub  main 0-31, middle 0-7, sub 0-255
//   two levels    main/sub         main 0-31, sub 0-2047
//   free          raw              1-65535
// 0/0/0 is the broadcast address: never a device address.
//
// An individual address (a device, or the tunnel itself) is area.line.device:
// area 0-15, line 0-15, device 0-255.
// -----------------------------------------------------------------------------

/** Why a text is not a group address (the key of an i18n message). */
export const ADDRESS_ERRORS = { FORMAT: 'format', RANGE: 'range', BROADCAST: 'broadcast' };

const int = (text) => Number.parseInt(text, 10);

/**
 * Parse a group address in any style: "1/2/3", "1/515", "2563", with
 * optional spaces and leading zeros. Returns { raw } or { error }.
 */
export function parseGroupAddress(text) {
  const value = String(text ?? '').replace(/\s+/g, '');
  let raw;
  let match = /^(\d{1,2})\/(\d{1,2})\/(\d{1,3})$/.exec(value);
  if (match) {
    const [main, middle, sub] = match.slice(1).map(int);
    if (main > 31 || middle > 7 || sub > 255) {
      return { error: ADDRESS_ERRORS.RANGE };
    }
    raw = (main << 11) | (middle << 8) | sub;
  } else if ((match = /^(\d{1,2})\/(\d{1,4})$/.exec(value))) {
    const [main, sub] = match.slice(1).map(int);
    if (main > 31 || sub > 2047) {
      return { error: ADDRESS_ERRORS.RANGE };
    }
    raw = (main << 11) | sub;
  } else if (/^\d{1,5}$/.test(value)) {
    raw = int(value);
    if (raw > 65535) {
      return { error: ADDRESS_ERRORS.RANGE };
    }
  } else {
    return { error: ADDRESS_ERRORS.FORMAT };
  }
  return raw === 0 ? { error: ADDRESS_ERRORS.BROADCAST } : { raw };
}

/** The text of a raw group address in the chosen style (three_level by default). */
export function formatGroupAddress(raw, style = 'three_level') {
  if (style === 'free') {
    return String(raw);
  }
  if (style === 'two_level') {
    return `${(raw >> 11) & 0x1f}/${raw & 0x7ff}`;
  }
  return `${(raw >> 11) & 0x1f}/${(raw >> 8) & 0x07}/${raw & 0xff}`;
}

/** Parse "1.1.250" into its raw 16 bits, or undefined. */
export function parseIndividualAddress(text) {
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{1,3})$/.exec(String(text ?? '').trim());
  if (!match) {
    return undefined;
  }
  const [area, line, device] = match.slice(1).map(int);
  if (area > 15 || line > 15 || device > 255) {
    return undefined;
  }
  return (area << 12) | (line << 8) | device;
}

export function formatIndividualAddress(raw) {
  return `${(raw >> 12) & 0x0f}.${(raw >> 8) & 0x0f}.${raw & 0xff}`;
}
