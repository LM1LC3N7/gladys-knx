// -----------------------------------------------------------------------------
// cEMI L_Data frames carrying group telegrams (KNX 03.06.03 EMI_IMI §4.1.5).
// Pure.
//
//   MC  AddIL [AddInfo]  Ctrl1 Ctrl2  Src(2) Dst(2)  NPDU-length  TPCI|APCI [data]
//
//   MC     0x11 L_Data.req (we send), 0x2E L_Data.con (the gateway confirms
//          our frame went out), 0x29 L_Data.ind (a frame seen on the bus)
//   Ctrl1  0xBC on what we send: standard frame, do not repeat, broadcast,
//          low priority, no ack request (as xknx does); bit 0 of a .con is
//          the error flag
//   Ctrl2  bit 7 group destination, bits 4-6 hop count (6), bits 0-3 the
//          extended frame format (0 = standard; anything else is ignored)
//   TPCI   0 for T_Data_Group; the APCI is the last 2 bits of that octet and
//          the next one: 0x000 GroupValue_Read, 0x040 _Response, 0x080 _Write
// -----------------------------------------------------------------------------

export const MESSAGE_CODES = { L_DATA_REQ: 0x11, L_DATA_CON: 0x2e, L_DATA_IND: 0x29 };
export const SERVICES = { READ: 'read', RESPONSE: 'response', WRITE: 'write' };

const APCI = { read: 0x000, response: 0x040, write: 0x080 };
const SERVICE_OF_APCI = { 0x000: 'read', 0x040: 'response', 0x080: 'write' };

const CTRL1_REQUEST = 0xbc;
const CTRL2_GROUP = 0xe0;
/** An L_Data_Standard frame carries at most 15 octets after the TPCI octet. */
const MAX_STANDARD_NPDU = 15;

/**
 * An L_Data.req to a group address. `payload` is { small, value } or
 * { small: false, data } (src/knx/dpt.js); a read has none. `source` is the
 * individual address the gateway assigned to the tunnel (0.0.0 lets the
 * gateway fill it in).
 */
export function groupRequest({ service, ga, source = 0, payload }) {
  const apci = APCI[service];
  if (apci === undefined) {
    throw new Error(`Unknown group service ${service}`);
  }
  let tpdu;
  if (service === SERVICES.READ) {
    tpdu = [0x00, 0x00];
  } else if (payload.small) {
    tpdu = [(apci >> 8) & 0x03, (apci & 0xff) | (payload.value & 0x3f)];
  } else {
    tpdu = [(apci >> 8) & 0x03, apci & 0xff, ...payload.data];
  }
  const npdu = tpdu.length - 1;
  if (npdu > MAX_STANDARD_NPDU) {
    throw new Error(`Group value too long (${npdu - 1} octets, 14 at most)`);
  }
  return Buffer.from([
    MESSAGE_CODES.L_DATA_REQ,
    0x00,
    CTRL1_REQUEST,
    CTRL2_GROUP,
    (source >> 8) & 0xff,
    source & 0xff,
    (ga >> 8) & 0xff,
    ga & 0xff,
    npdu,
    ...tpdu,
  ]);
}

/**
 * A received cEMI frame -> a group telegram, or undefined for anything this
 * integration does not handle (individual addressing, connection control,
 * management, secure APDUs, extended frames, a broken length):
 *   { code: 'ind' | 'con', error, source, ga, service, payload }
 * `error` is the negative confirmation flag of an L_Data.con.
 */
export function parseCemi(buffer) {
  const raw = Buffer.from(buffer);
  if (raw.length < 2) {
    return undefined;
  }
  const code =
    raw[0] === MESSAGE_CODES.L_DATA_IND ? 'ind' : raw[0] === MESSAGE_CODES.L_DATA_CON ? 'con' : '';
  if (!code) {
    return undefined;
  }
  const frame = raw.subarray(2 + raw[1]);
  if (frame.length < 9) {
    return undefined;
  }
  const [ctrl1, ctrl2] = frame;
  if (!(ctrl2 & 0x80) || ctrl2 & 0x0f) {
    return undefined; // individual destination, or an extended (LTE) frame
  }
  const npdu = frame[6];
  const tpdu = frame.subarray(7);
  if (tpdu.length !== npdu + 1 || npdu < 1) {
    return undefined;
  }
  if ((tpdu[0] & 0xfc) !== 0) {
    return undefined; // not T_Data_Group (tag group, numbered, control)
  }
  const apci = ((tpdu[0] & 0x03) << 8) | tpdu[1];
  const service = SERVICE_OF_APCI[apci & 0x3c0];
  if (!service) {
    return undefined;
  }
  const ga = (frame[4] << 8) | frame[5];
  if (ga === 0) {
    return undefined; // broadcast
  }
  let payload;
  if (service === SERVICES.READ) {
    if (npdu !== 1) {
      return undefined;
    }
  } else if (npdu === 1) {
    payload = { small: true, value: tpdu[1] & 0x3f };
  } else {
    payload = { small: false, data: Buffer.from(tpdu.subarray(2)) };
  }
  return {
    code,
    error: code === 'con' && Boolean(ctrl1 & 0x01),
    source: (frame[2] << 8) | frame[3],
    ga,
    service,
    payload,
  };
}
