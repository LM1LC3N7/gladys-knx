// -----------------------------------------------------------------------------
// Addresses, cEMI and KNXnet/IP frames, byte for byte. The hex strings are the
// frames of the xknx test suite (test/knxip_tests, test/cemi_tests,
// test/io_tests), some of them captured on real installations.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatGroupAddress,
  formatIndividualAddress,
  parseGroupAddress,
  parseIndividualAddress,
} from '../src/knx/address.js';
import { groupRequest, parseCemi } from '../src/knx/cemi.js';
import { decode } from '../src/knx/dpt.js';
import {
  FrameError,
  HOST_PROTOCOL,
  SERVICE,
  connectRequest,
  connectionStateRequest,
  disconnectRequest,
  frameLength,
  hpai,
  parseFrame,
  statusName,
  tunnellingAck,
  tunnellingRequest,
} from '../src/knx/frames.js';
import { ROUTER_DESCRIPTION, hex } from './helpers/fakeGateway.js';

test('group addresses: three levels, two levels, free; the same raw value', () => {
  assert.deepEqual(parseGroupAddress('1/2/3'), { raw: 0x0a03 });
  assert.deepEqual(parseGroupAddress(' 01/2/003 '), { raw: 0x0a03 });
  assert.deepEqual(parseGroupAddress('1/515'), { raw: 0x0a03 });
  assert.deepEqual(parseGroupAddress('2563'), { raw: 0x0a03 });
  assert.deepEqual(parseGroupAddress('31/7/255'), { raw: 0xffff });
  assert.deepEqual(parseGroupAddress('9/0/8'), { raw: 0x4808 });
  assert.deepEqual(parseGroupAddress('32/0/0'), { error: 'range' });
  assert.deepEqual(parseGroupAddress('1/8/0'), { error: 'range' });
  assert.deepEqual(parseGroupAddress('1/2048'), { error: 'range' });
  assert.deepEqual(parseGroupAddress('65536'), { error: 'range' });
  assert.deepEqual(parseGroupAddress('0/0/0'), { error: 'broadcast' });
  assert.deepEqual(parseGroupAddress('1.1.1'), { error: 'format' });
  assert.deepEqual(parseGroupAddress(''), { error: 'format' });
  assert.equal(formatGroupAddress(0x0a03), '1/2/3');
  assert.equal(formatGroupAddress(0x0a03, 'two_level'), '1/515');
  assert.equal(formatGroupAddress(0x0a03, 'free'), '2563');
  assert.equal(formatIndividualAddress(0x11ff), '1.1.255');
  assert.equal(parseIndividualAddress('15.15.250'), 0xfffa);
  assert.equal(parseIndividualAddress('16.0.0'), undefined);
});

test('cEMI: the L_Data.req of a group write, read and response', () => {
  // xknx tunnelling_request_test: GroupValueWrite 1 to 9/0/8 from 0.0.0.
  assert.deepEqual(
    groupRequest({ service: 'write', ga: 0x4808, payload: { small: true, value: 1 } }),
    hex('11 00 bc e0 00 00 48 08 01 00 81'),
  );
  assert.deepEqual(
    groupRequest({ service: 'read', ga: 0x0a03, source: 0x11ff }),
    hex('11 00 bc e0 11 ff 0a 03 01 00 00'),
  );
  assert.deepEqual(
    groupRequest({
      service: 'response',
      ga: 0x0a03,
      source: 0x11ff,
      payload: { small: false, data: hex('0c 1a') },
    }),
    hex('11 00 bc e0 11 ff 0a 03 03 00 40 0c 1a'),
  );
  assert.throws(() =>
    groupRequest({ service: 'write', ga: 1, payload: { small: false, data: Buffer.alloc(15) } }),
  );
});

test('cEMI: real frames of the bus are read, everything else is ignored', () => {
  // xknx io_tests: L_Data.ind GroupValueWrite from 1.1.22 to 5/1/22, 21.74 °C.
  const telegram = parseCemi(hex('2900bcd011162916030080 0c 3f'));
  assert.deepEqual(telegram, {
    code: 'ind',
    error: false,
    source: 0x1116,
    ga: 0x2916,
    service: 'write',
    payload: { small: false, data: hex('0c3f') },
  });
  assert.equal(decode('9.001', telegram.payload), 21.74);
  // xknx cemi_tests: a GroupValueRead to 0/0/1 with additional info length 0.
  assert.equal(parseCemi(hex('29 00 80 80 00 01 00 01 01 00 00')).service, 'read');
  // A confirmation carrying the error flag.
  const confirmation = parseCemi(hex('2e 00 bd e0 11 ff 0a 03 01 00 81'));
  assert.equal(confirmation.code, 'con');
  assert.equal(confirmation.error, true);
  // Additional information is skipped by its length.
  assert.equal(parseCemi(hex('29 03 01 02 03 bc d0 11 16 0a 03 01 00 41')).payload.value, 1);
  // T_Connect to an individual address (xknx io_tests): not a group telegram.
  assert.equal(parseCemi(hex('2900b06010fa10ff0080')), undefined);
  // A real L_Data.con of an A_SecureData APDU with no ASDU (xknx cemi_tests).
  assert.equal(parseCemi(hex('2e00bcf011fd094e0103f1')), undefined);
  // Truncated (xknx io_tests), wrong NPDU length, extended frame format, broadcast.
  assert.equal(parseCemi(hex('2900b06010fa10ff00')), undefined);
  assert.equal(parseCemi(hex('29 00 bc d0 11 16 0a 03 02 00 80')), undefined);
  assert.equal(parseCemi(hex('29 00 bc d4 11 16 0a 03 01 00 81')), undefined);
  assert.equal(parseCemi(hex('29 00 bc d0 11 16 00 00 01 00 81')), undefined);
});

test('KNXnet/IP client frames, byte for byte', () => {
  // xknx knxip_tests HPAIs: 192.168.42.1:33941 and 192.168.200.12:50100.
  assert.deepEqual(
    Buffer.from(hpai(HOST_PROTOCOL.UDP, '192.168.42.1', 33941)),
    hex('0801c0a82a018495'),
  );
  assert.deepEqual(
    Buffer.from(hpai(HOST_PROTOCOL.UDP, '192.168.200.12', 50100)),
    hex('0801c0a8c80cc3b4'),
  );
  // The same frames as xknx's, with the route-back HPAI 0.0.0.0:0 of a NATed client.
  assert.deepEqual(
    connectRequest(),
    hex('06 10 02 05 00 1a 08 01 00 00 00 00 00 00 08 01 00 00 00 00 00 00 04 04 02 00'),
  );
  assert.deepEqual(
    connectionStateRequest(0x15),
    hex('06 10 02 07 00 10 15 00 08 01 00 00 00 00 00 00'),
  );
  assert.deepEqual(
    disconnectRequest(0x15, HOST_PROTOCOL.TCP),
    hex('06 10 02 09 00 10 15 00 08 02 00 00 00 00 00 00'),
  );
  // xknx tunnelling_ack_test, verbatim.
  assert.deepEqual(tunnellingAck(0x2a, 0x17), hex('06 10 04 21 00 0a 04 2a 17 00'));
  // xknx tunnelling_request_test, verbatim.
  assert.deepEqual(
    tunnellingRequest(1, 23, hex('11 00 bc e0 00 00 48 08 01 00 81')),
    hex('06 10 04 20 00 15 04 01 17 00 11 00 bc e0 00 00 48 08 01 00 81'),
  );
});

test('KNXnet/IP gateway frames: the xknx vectors, MDT error answers, a real description', () => {
  assert.deepEqual(parseFrame(hex('06 10 02 06 00 14 01 00 08 01 C0 A8 2A 0A 0E 57 04 04 11 FF')), {
    service: SERVICE.CONNECT_RESPONSE,
    channel: 1,
    status: 0,
    dataEndpoint: { protocol: 1, ip: '192.168.42.10', port: 3671 },
    address: 4607,
  });
  // An MDT interface answering "no more connections", HPAI and CRD zeroed.
  assert.deepEqual(parseFrame(hex('06 10 02 06 00 08 00 24 00 00 00 00 00 00 00 00 00 00')), {
    service: SERVICE.CONNECT_RESPONSE,
    channel: 0,
    status: 0x24,
  });
  assert.equal(statusName(0x24), 'E_NO_MORE_CONNECTIONS (0x24)');
  assert.deepEqual(parseFrame(hex('06 10 02 08 00 08 15 21')), {
    service: SERVICE.CONNECTIONSTATE_RESPONSE,
    channel: 0x15,
    status: 0x21,
  });
  assert.deepEqual(parseFrame(hex('06 10 02 0a 00 08 15 25')), {
    service: SERVICE.DISCONNECT_RESPONSE,
    channel: 0x15,
    status: 0x25,
  });
  assert.deepEqual(parseFrame(hex('06 10 04 21 00 0a 04 2a 17 00')), {
    service: SERVICE.TUNNELLING_ACK,
    channel: 0x2a,
    sequence: 0x17,
    status: 0,
  });
  const indication = parseFrame(hex('0610 0420 0017 04 02 21 00 2900bcd011162916030080 0c 3f'));
  assert.equal(indication.channel, 2);
  assert.equal(indication.sequence, 0x21);
  assert.deepEqual(indication.cemi, hex('2900bcd0111629160300800c3f'));
  // A real "KNX/IP-Router" (xknx description_response_test).
  const description = parseFrame(ROUTER_DESCRIPTION);
  assert.equal(description.name, 'KNX/IP-Router');
  assert.equal(description.address, 0x1000);
  assert.equal(description.medium, 0x02);
  assert.equal(description.mac, '00:0a:b3:27:4a:32');
  assert.deepEqual(description.families[2], { family: 0x04, version: 2 });
  // Broken frames: a short body, a wrong header, a frame cut short.
  assert.throws(() => parseFrame(hex('06 10 02 08 00 07 15')), FrameError);
  assert.throws(() => parseFrame(hex('06 20 02 08 00 08 15 00')), FrameError);
  assert.throws(() => parseFrame(hex('06 10 04 20 00 15 04 01')), FrameError);
  assert.equal(frameLength(hex('06 10 04')), undefined);
  assert.equal(parseFrame(hex('06 10 05 30 00 06')).service, 0x0530, 'unknown services pass');
});
