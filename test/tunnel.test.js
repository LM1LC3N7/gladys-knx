// -----------------------------------------------------------------------------
// The tunnel client against the fake gateway, byte for byte, with a fake
// clock for the 1 s / 10 s / 60 s timings of the specification.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { KnxTunnel, probeGateway } from '../src/knx/tunnel.js';
import { small, data } from '../src/knx/dpt.js';
import { createFakeClock } from './helpers/fakeClock.js';
import { ga, hex, indication, installGateway } from './helpers/fakeGateway.js';

const quiet = {
  info() {},
  warn: (...a) => process.env.DEBUG_TEST && console.error(...a),
  error() {},
  debug() {},
};

let fake;
afterEach(() => fake?.restore());

async function open({ protocol = 'udp', before = () => {} } = {}) {
  fake = installGateway({ protocol });
  before(fake.gateway);
  const clock = createFakeClock();
  const telegrams = [];
  const statuses = [];
  const tunnel = new KnxTunnel({
    host: '192.168.1.10',
    port: 3671,
    protocol,
    logger: quiet,
    timers: clock.timers,
    now: clock.now,
    onTelegram: (t) => telegrams.push(t),
    onStatus: (s) => statuses.push(s),
  });
  tunnel.start();
  await clock.advance(0);
  return { tunnel, gateway: fake.gateway, clock, telegrams, statuses };
}

test('UDP: description, then CONNECT_REQUEST with the route-back HPAI and a tunnel CRI', async () => {
  const { tunnel, gateway, statuses } = await open();
  assert.deepEqual(gateway.frames[0], hex('06 10 02 03 00 0e 08 01 00 00 00 00 00 00'));
  assert.deepEqual(
    gateway.frames[1],
    hex('06 10 02 05 00 1a 08 01 00000000 0000 08 01 00000000 0000 04 04 02 00'),
  );
  assert.equal(tunnel.connected, true);
  assert.equal(tunnel.channel, 21);
  assert.equal(tunnel.address, 0x11ff);
  assert.equal(tunnel.description.name, 'KNX/IP-Router');
  assert.deepEqual(tunnel.dataEndpoint, { host: '192.168.1.10', port: 3671 });
  assert.deepEqual(statuses, [{ connected: true }]);
  await tunnel.stop();
  assert.deepEqual(
    gateway.received(0x0209).at(-1),
    hex('06 10 02 09 00 10 15 00 08 01 00 00 00 00 00 00'),
  );
});

test('a write: TUNNELLING_REQUEST byte for byte, ACK, L_Data.con, sequence counter', async () => {
  const { tunnel, gateway, clock } = await open();
  const first = tunnel.write(ga('9/0/8'), small(1));
  await clock.advance(0);
  await first;
  // The cEMI of xknx's test: L_Data.req, 0xBC 0xE0, from the tunnel address 1.1.255.
  assert.deepEqual(
    gateway.received(0x0420)[0],
    hex('06 10 04 20 00 15 04 15 00 00 11 00 bc e0 11 ff 48 08 01 00 81'),
  );
  const second = tunnel.write(ga('1/2/3'), data([0x0c, 0x1a]));
  await clock.advance(100);
  await second;
  assert.equal(gateway.requests[1].sequence, 1);
  assert.deepEqual(gateway.requests[1].cemi, hex('11 00 bc e0 11 ff 0a 03 03 00 80 0c 1a'));
  // The two confirmations were TUNNELLING_REQUESTs of the gateway: acknowledged.
  assert.deepEqual(
    gateway.acks.map((a) => a.sequence),
    [0, 1],
  );
  assert.equal(tunnel.counters.sent, 2);
  await tunnel.stop();
});

test('telegrams of the bus: acknowledged, repeated ones dropped, a gap rebuilds the tunnel', async () => {
  const { tunnel, gateway, clock, telegrams, statuses } = await open();
  gateway.indicate(indication({ to: '5/1/22', value: '0c 3f' }));
  await clock.advance(0);
  assert.equal(telegrams.length, 1);
  assert.equal(telegrams[0].ga, ga('5/1/22'));
  assert.equal(telegrams[0].source, 0x1116);
  assert.deepEqual(telegrams[0].payload, { small: false, data: hex('0c 3f') });
  assert.deepEqual(gateway.frames.at(-1), hex('06 10 04 21 00 0a 04 15 00 00'));
  // A datagram from any other address than the gateway's is ignored.
  gateway.tunnelSocket.deliver(
    hex('06 10 04 20 00 15 04 15 01 00 29 00 bc d0 11 16 09 01 01 00 81'),
    '192.168.1.66',
  );
  await clock.advance(0);
  assert.equal(telegrams.length, 1);
  assert.equal(gateway.acks.length, 1);
  // The same counter again: our ACK got lost; acknowledged again, not handled again.
  gateway.indicate(indication({ to: '5/1/22', value: '0c 3f' }), { sequence: 0 });
  await clock.advance(0);
  assert.equal(telegrams.length, 1);
  assert.equal(gateway.acks.length, 2);
  // A counter out of step: dropped without an ACK; nothing better within 2 s.
  gateway.indicate(indication({ to: '1/1/1', value: 1 }), { sequence: 7 });
  await clock.advance(0);
  assert.equal(telegrams.length, 1);
  assert.equal(gateway.acks.length, 2);
  await clock.advance(2000);
  assert.equal(statuses.at(-1).connected, false);
  assert.equal(statuses.at(-1).error.code, 'lost');
  await clock.advance(2000);
  assert.equal(tunnel.connected, true, 'reconnected after 2 s');
  await tunnel.stop();
});

test('no ACK: one repeat with the same counter, then DISCONNECT and a new tunnel', async () => {
  const { tunnel, gateway, clock, statuses } = await open();
  gateway.answers.ack = false;
  gateway.answers.confirm = false;
  const write = tunnel.write(ga('1/1/1'), small(1));
  const rejected = assert.rejects(write, (err) => err.code === 'ack');
  await clock.advance(2000);
  await rejected;
  const requests = gateway.received(0x0420);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1], 'the repeat carries the same sequence counter');
  assert.equal(gateway.received(0x0209).length, 1, 'DISCONNECT_REQUEST sent');
  assert.equal(statuses.at(-1).retryInMs, 2000);
  gateway.answers.ack = true;
  await clock.advance(2000);
  assert.equal(tunnel.connected, true);
  assert.equal(tunnel.outSequence, 0, 'a new tunnel counts from 0');
  await tunnel.stop();
});

test('heartbeat every 60 s; three missed answers rebuild the tunnel', async () => {
  const { tunnel, gateway, clock, statuses } = await open();
  await clock.advance(60_000);
  assert.deepEqual(
    gateway.received(0x0207)[0],
    hex('06 10 02 07 00 10 15 00 08 01 00 00 00 00 00 00'),
  );
  assert.equal(tunnel.connected, true);
  gateway.answers.heartbeat = false;
  await clock.advance(60_000 + 25_000);
  assert.equal(tunnel.connected, true, 'two failures are not enough');
  await clock.advance(5_000);
  assert.equal(gateway.received(0x0207).length, 4);
  assert.equal(statuses.at(-1).error.code, 'lost');
  assert.match(statuses.at(-1).error.message, /heartbeat/);
  await tunnel.stop();
});

test('every tunnel of the gateway taken: retry in a minute, said as such', async () => {
  const { tunnel, gateway, clock, statuses } = await open({
    before: (g) => {
      g.answers.connectStatus = 0x24;
    },
  });
  assert.equal(tunnel.connected, false);
  assert.equal(statuses[0].error.code, 'busy');
  assert.match(statuses[0].error.message, /E_NO_MORE_CONNECTIONS \(0x24\)/);
  assert.equal(statuses[0].retryInMs, 60_000);
  gateway.answers.connectStatus = 0;
  await clock.advance(60_000);
  assert.equal(tunnel.connected, true);
  await tunnel.stop();
});

test('the gateway ends the tunnel: DISCONNECT_RESPONSE, then a new tunnel', async () => {
  const { tunnel, gateway, clock, statuses } = await open();
  gateway.disconnect();
  await clock.advance(0);
  assert.deepEqual(gateway.frames.at(-1), hex('06 10 02 0a 00 08 15 00'));
  assert.equal(statuses.at(-1).error.code, 'closed');
  await clock.advance(2000);
  assert.equal(tunnel.connected, true);
  await tunnel.stop();
});

test('a negative L_Data.con fails the write; commands go before the waiting reads', async () => {
  const { tunnel, gateway, clock } = await open();
  const reads = [tunnel.read(ga('1/1/2')), tunnel.read(ga('1/1/3')), tunnel.read(ga('1/1/2'))];
  const write = tunnel.write(ga('1/1/1'), small(1));
  await clock.advance(1000);
  await Promise.all([...reads, write]);
  assert.deepEqual(
    gateway.requests.map((r) => r.cemi.subarray(6, 8).readUInt16BE(0)),
    [ga('1/1/2'), ga('1/1/1'), ga('1/1/3')],
    'the read already on its way is not sent twice',
  );
  assert.deepEqual(gateway.requests[0].cemi, hex('11 00 bc e0 11 ff 09 02 01 00 00'));
  gateway.answers.confirmError = true;
  const failing = assert.rejects(tunnel.write(ga('1/1/1'), small(0)), (err) => err.code === 'bus');
  await clock.advance(500);
  await failing;
  await tunnel.stop();
});

test('TCP: same frames with the TCP HPAI, a cut stream, no ACK either way', async () => {
  const { tunnel, gateway, clock, telegrams } = await open({ protocol: 'tcp' });
  assert.equal(tunnel.connected, true);
  assert.deepEqual(
    gateway.received(0x0205)[0],
    hex('06 10 02 05 00 1a 08 02 00000000 0000 08 02 00000000 0000 04 04 02 00'),
  );
  assert.equal(tunnel.dataEndpoint, undefined);
  const write = tunnel.write(ga('2/1/1'), small(1));
  await clock.advance(0);
  await write;
  gateway.indicate(indication({ to: '2/1/4', value: '33', apci: 0x40 }));
  await clock.advance(0);
  assert.equal(telegrams.length, 1);
  assert.equal(telegrams[0].service, 'response');
  assert.equal(gateway.acks.length, 0, 'no TUNNELLING_ACK over TCP');
  await clock.advance(60_000);
  assert.equal(gateway.received(0x0207).length, 1);
  assert.deepEqual(gateway.received(0x0207)[0].subarray(8, 10), hex('08 02'));
  await tunnel.stop();
});

test('the Test probe: description only, or a short tunnel; a silent gateway times out', async () => {
  fake = installGateway();
  const clock = createFakeClock();
  const options = {
    host: '192.168.1.10',
    port: 3671,
    protocol: 'udp',
    logger: quiet,
    timers: clock.timers,
    now: clock.now,
  };
  const described = probeGateway(options, { connect: false });
  await clock.advance(0);
  assert.equal((await described).description.name, 'KNX/IP-Router');
  assert.equal(fake.gateway.received(0x0205).length, 0);
  const tunnel = probeGateway(options);
  await clock.advance(0);
  assert.equal((await tunnel).address, 0x11ff);
  assert.equal(fake.gateway.received(0x0209).length, 1, 'the probe tunnel is closed again');
  fake.gateway.down = true;
  const silent = probeGateway(options);
  const rejected = assert.rejects(silent, (err) => err.code === 'timeout');
  await clock.advance(15_000);
  await rejected;
});
