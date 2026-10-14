// -----------------------------------------------------------------------------
// KNXnet/IP frames (KNX 03.08.02 Core, 03.08.04 Tunnelling). Pure.
//
// Every frame: 06 10 <service type, 2> <total length, 2> <body>.
//
// The client always announces the "route back" HPAI 0.0.0.0:0: the container
// sits behind Docker's NAT, so the gateway must answer to the address and
// port the request came from, never to an address we would put in the frame
// (KNX 03.08.02 §8.6.3.6 "NAT").
// -----------------------------------------------------------------------------

export const HEADER_LENGTH = 0x06;
export const PROTOCOL_VERSION = 0x10;

export const SERVICE = {
  DESCRIPTION_REQUEST: 0x0203,
  DESCRIPTION_RESPONSE: 0x0204,
  CONNECT_REQUEST: 0x0205,
  CONNECT_RESPONSE: 0x0206,
  CONNECTIONSTATE_REQUEST: 0x0207,
  CONNECTIONSTATE_RESPONSE: 0x0208,
  DISCONNECT_REQUEST: 0x0209,
  DISCONNECT_RESPONSE: 0x020a,
  TUNNELLING_REQUEST: 0x0420,
  TUNNELLING_ACK: 0x0421,
};

export const HOST_PROTOCOL = { UDP: 0x01, TCP: 0x02 };

/** Connection type and KNX layer of a tunnel CRI. */
const TUNNEL_CONNECTION = 0x04;
const TUNNEL_LINK_LAYER = 0x02;

/** The status codes a gateway answers with (03.08.02 §7.8.4 and Tunnelling). */
export const STATUS = {
  NO_ERROR: 0x00,
  HOST_PROTOCOL_TYPE: 0x01,
  VERSION_NOT_SUPPORTED: 0x02,
  SEQUENCE_NUMBER: 0x04,
  ERROR: 0x0f,
  CONNECTION_ID: 0x21,
  CONNECTION_TYPE: 0x22,
  CONNECTION_OPTION: 0x23,
  NO_MORE_CONNECTIONS: 0x24,
  NO_MORE_UNIQUE_CONNECTIONS: 0x25,
  DATA_CONNECTION: 0x26,
  KNX_CONNECTION: 0x27,
  AUTHORISATION_ERROR: 0x28,
  TUNNELLING_LAYER: 0x29,
  NO_TUNNELLING_ADDRESS: 0x2d,
  CONNECTION_IN_USE: 0x2e,
};

const STATUS_NAMES = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [v, `E_${k}`]));

/** "E_NO_MORE_CONNECTIONS (0x24)" */
export const statusName = (code) =>
  `${STATUS_NAMES[code] ?? 'E_UNKNOWN'} (0x${code.toString(16).padStart(2, '0')})`;

export class FrameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FrameError';
  }
}

function frame(service, body = []) {
  const length = HEADER_LENGTH + body.length;
  return Buffer.from([
    HEADER_LENGTH,
    PROTOCOL_VERSION,
    (service >> 8) & 0xff,
    service & 0xff,
    (length >> 8) & 0xff,
    length & 0xff,
    ...body,
  ]);
}

/** Host Protocol Address Information: the route-back one by default. */
export function hpai(protocol = HOST_PROTOCOL.UDP, ip = '0.0.0.0', port = 0) {
  const octets = ip.split('.').map(Number);
  return [0x08, protocol, ...octets, (port >> 8) & 0xff, port & 0xff];
}

function parseHpai(body, offset) {
  if (body.length < offset + 8 || body[offset] !== 0x08) {
    throw new FrameError('wrong HPAI length');
  }
  return {
    protocol: body[offset + 1],
    ip: [...body.subarray(offset + 2, offset + 6)].join('.'),
    port: (body[offset + 6] << 8) | body[offset + 7],
  };
}

// --- Client frames ----------------------------------------------------------------

export const descriptionRequest = (protocol = HOST_PROTOCOL.UDP) =>
  frame(SERVICE.DESCRIPTION_REQUEST, hpai(protocol));

/** A basic tunnel CRI (no individual address requested): 04 04 02 00. */
export const connectRequest = (protocol = HOST_PROTOCOL.UDP) =>
  frame(SERVICE.CONNECT_REQUEST, [
    ...hpai(protocol),
    ...hpai(protocol),
    0x04,
    TUNNEL_CONNECTION,
    TUNNEL_LINK_LAYER,
    0x00,
  ]);

export const connectionStateRequest = (channel, protocol = HOST_PROTOCOL.UDP) =>
  frame(SERVICE.CONNECTIONSTATE_REQUEST, [channel, 0x00, ...hpai(protocol)]);

export const disconnectRequest = (channel, protocol = HOST_PROTOCOL.UDP) =>
  frame(SERVICE.DISCONNECT_REQUEST, [channel, 0x00, ...hpai(protocol)]);

export const disconnectResponse = (channel, status = STATUS.NO_ERROR) =>
  frame(SERVICE.DISCONNECT_RESPONSE, [channel, status]);

export const tunnellingRequest = (channel, sequence, cemi) =>
  frame(SERVICE.TUNNELLING_REQUEST, [0x04, channel, sequence & 0xff, 0x00, ...cemi]);

export const tunnellingAck = (channel, sequence, status = STATUS.NO_ERROR) =>
  frame(SERVICE.TUNNELLING_ACK, [0x04, channel, sequence & 0xff, status]);

// --- Reading ------------------------------------------------------------------------------

/**
 * The length of the frame at the start of `buffer` (from its header), or
 * undefined while fewer than 6 octets are there. Throws on a header that is
 * not KNXnet/IP 1.0: a TCP stream cannot resynchronize after that.
 */
export function frameLength(buffer) {
  if (buffer.length < HEADER_LENGTH) {
    return undefined;
  }
  if (buffer[0] !== HEADER_LENGTH || buffer[1] !== PROTOCOL_VERSION) {
    throw new FrameError('not a KNXnet/IP 1.0 header');
  }
  const length = (buffer[4] << 8) | buffer[5];
  if (length < HEADER_LENGTH) {
    throw new FrameError('wrong total length');
  }
  return length;
}

function parseDescription(body) {
  const description = { families: [] };
  let offset = 0;
  while (offset + 2 <= body.length) {
    const length = body[offset];
    const type = body[offset + 1];
    if (length < 2 || offset + length > body.length) {
      break;
    }
    const dib = body.subarray(offset, offset + length);
    if (type === 0x01 && length >= 54) {
      description.medium = dib[2];
      description.programmingMode = Boolean(dib[3] & 0x01);
      description.address = (dib[4] << 8) | dib[5];
      description.serial = dib.subarray(8, 14).toString('hex');
      description.mac = [...dib.subarray(18, 24)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(':');
      description.name = dib
        .subarray(24, 54)
        .toString('latin1')
        .replace(/\0[\s\S]*$/, '')
        .trim();
    } else if (type === 0x02) {
      for (let i = 2; i + 1 < length; i += 2) {
        description.families.push({ family: dib[i], version: dib[i + 1] });
      }
    }
    offset += length;
  }
  return description;
}

/**
 * One whole frame -> { service, ...fields }. Unknown services come back as
 * { service } only; a malformed known one throws a FrameError.
 */
export function parseFrame(buffer) {
  const raw = Buffer.from(buffer);
  const length = frameLength(raw);
  if (length === undefined || raw.length < length) {
    throw new FrameError('frame shorter than its header says');
  }
  const service = (raw[2] << 8) | raw[3];
  const body = raw.subarray(HEADER_LENGTH, length);
  const need = (n) => {
    if (body.length < n) {
      throw new FrameError(`body of 0x${service.toString(16)} too short`);
    }
  };
  switch (service) {
    case SERVICE.CONNECT_RESPONSE: {
      need(2);
      const result = { service, channel: body[0], status: body[1] };
      // An error answer may carry a zeroed HPAI and CRD, or nothing (MDT).
      if (result.status === STATUS.NO_ERROR) {
        result.dataEndpoint = parseHpai(body, 2);
        need(14);
        if (body[10] !== 0x04 || body[11] !== TUNNEL_CONNECTION) {
          throw new FrameError('not a tunnel CRD');
        }
        result.address = (body[12] << 8) | body[13];
      }
      return result;
    }
    case SERVICE.CONNECTIONSTATE_RESPONSE:
    case SERVICE.DISCONNECT_RESPONSE:
      need(2);
      return { service, channel: body[0], status: body[1] };
    case SERVICE.DISCONNECT_REQUEST:
      need(2);
      return { service, channel: body[0] };
    case SERVICE.TUNNELLING_REQUEST:
      need(4);
      if (body[0] !== 0x04) {
        throw new FrameError('wrong connection header length');
      }
      return { service, channel: body[1], sequence: body[2], cemi: Buffer.from(body.subarray(4)) };
    case SERVICE.TUNNELLING_ACK:
      need(4);
      if (body[0] !== 0x04) {
        throw new FrameError('wrong connection header length');
      }
      return { service, channel: body[1], sequence: body[2], status: body[3] };
    case SERVICE.DESCRIPTION_RESPONSE:
      return { service, ...parseDescription(body) };
    default:
      return { service };
  }
}

/** The KNX media of a description (DIB device info). */
export const MEDIUM_NAMES = { 0x02: 'TP1', 0x04: 'PL110', 0x10: 'RF', 0x20: 'KNX IP' };
/** Service family 0x04 is tunnelling; its version 2 brings TCP. */
export const FAMILY_TUNNELLING = 0x04;
