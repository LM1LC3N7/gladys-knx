// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and the fake gateway.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { KnxApp } from '../src/app.js';
import { ACTIONS, SCENE_ACTIONS, SCENE_TRIGGERS, WIDGETS } from '../src/constants.js';
import { createFakeClock } from './helpers/fakeClock.js';
import { indication, installGateway } from './helpers/fakeGateway.js';

const quiet = {
  info() {},
  warn: (...a) => process.env.DEBUG_TEST && console.error(...a),
  error() {},
  debug() {},
};

let fake;
let running;
let currentClock;
afterEach(async () => {
  const stopping = running?.stop();
  await currentClock?.advance(2000);
  await stopping;
  running = undefined;
  fake?.restore();
});

const DEVICES = [
  'light; Living room; switch=1/1/1; state=1/1/2',
  'shutter; Bedroom; move=2/1/1; stop=2/1/2; position=2/1/3; position_state=2/1/4',
  'thermostat; Office; setpoint=5/1/1; temperature=5/1/3; mode=5/1/4; mode_state=5/1/5',
  'sensor; Meter; power=4/2/1',
].join('\n');

const CONFIG = { host: '192.168.1.10', devices: DEVICES };

const created = (id, name) => ({ external_id: `ext:knx:${id}`, name, features: [] });
const CREATED = [
  created('light:living-room', 'Living room'),
  created('shutter:bedroom', 'Bedroom'),
  created('thermostat:office', 'Office'),
  created('sensor:meter', 'Meter'),
];

async function setup({ config = CONFIG, devices = CREATED, gatewayOptions, start = true } = {}) {
  fake = installGateway(gatewayOptions);
  const clock = createFakeClock();
  currentClock = clock;
  const gladys = createFakeGladys({ selector: 'knx', config, devices });
  const app = new KnxApp({ gladys, logger: quiet, now: clock.now, timers: clock.timers });
  running = app;
  gladys.onScanRequest(() => app.publishDevices());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));
  gladys.onSceneAction(SCENE_ACTIONS.SEND, (fields) => app.sendGroupValue(fields));
  gladys.onWidgetGet(WIDGETS.BUS, (request) => app.getWidget(WIDGETS.BUS, request));
  gladys.onAction(ACTIONS.TEST, () => app.testGateway());
  await gladys.connect();
  if (start) {
    await app.start(config);
    await clock.advance(0);
  }
  return { app, gladys, clock, gateway: fake.gateway };
}

/** The group address and APCI octets of the cEMI the gateway received. */
const sentTo = (gateway) =>
  gateway.requests.map((r) => [
    `${r.cemi[6] >> 3}/${r.cemi[6] & 7}/${r.cemi[7]}`,
    r.cemi.subarray(9).toString('hex'),
  ]);

test('no gateway address: Discovery still offers the devices, the status says what to do', async () => {
  const { gladys } = await setup({
    config: { devices: `${DEVICES}\nlight; Broken; switch=40/1/1` },
    devices: [],
  });
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => d.external_id),
    [
      'ext:knx:light:living-room',
      'ext:knx:shutter:bedroom',
      'ext:knx:thermostat:office',
      'ext:knx:sensor:meter',
    ],
  );
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /Type the IP address/);
  assert.match(gladys.fake.connectionStatus.message.fr, /Appareil n°5 : « 40\/1\/1 »/);
  assert.equal(fake.gateway.frames.length, 0);
});

test('connected: the status names the gateway, the status addresses are read 250 ms apart', async () => {
  const { gladys, clock, gateway } = await setup();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(
    gladys.fake.connectionStatus.message.en,
    'Tunnel open to "KNX/IP-Router" (192.168.1.10, 1.0.0, TP1, tunnelling v2) as 1.1.255: 4 devices declared, 4 created.',
  );
  assert.deepEqual(sentTo(gateway), [['1/1/2', '0000']]);
  await clock.advance(250);
  assert.deepEqual(sentTo(gateway).at(-1), ['2/1/4', '0000']);
  await clock.advance(1000);
  assert.deepEqual(
    sentTo(gateway).map(([address]) => address),
    ['1/1/2', '2/1/4', '5/1/3', '5/1/5', '4/2/1'],
    'only the status and sensor addresses',
  );
  // The answers become states, never scene events.
  gateway.indicate(indication({ to: '1/1/2', value: 1, apci: 0x40 }));
  gateway.indicate(indication({ to: '2/1/4', value: '4c', apci: 0x40 }));
  gateway.indicate(indication({ to: '5/1/5', value: '01', apci: 0x40 }));
  await clock.advance(0);
  assert.equal(gladys.fake.lastState('ext:knx:light:living-room:switch'), 1);
  assert.equal(gladys.fake.lastState('ext:knx:shutter:bedroom:position'), 70, '30 % closed');
  assert.equal(gladys.fake.lastState('ext:knx:thermostat:office:mode'), 5, 'comfort');
  assert.equal(gladys.fake.sceneEvents.length, 0);
});

test('bus writes: states, one scene event each, measurements at most every 30 s', async () => {
  const { gladys, clock, gateway } = await setup();
  await clock.advance(2000);
  gateway.indicate(indication({ to: '1/1/1', value: 1, source: 0x1105 }));
  gateway.indicate(indication({ to: '7/1/1', value: 1 }));
  gateway.indicate(indication({ to: '4/2/1', value: '43c68000' }));
  await clock.advance(0);
  assert.equal(gladys.fake.lastState('ext:knx:light:living-room:switch'), 1, 'a wall switch');
  assert.equal(gladys.fake.lastState('ext:knx:sensor:meter:power'), 397);
  const events = gladys.fake.sceneEvents;
  assert.deepEqual(
    events.map((e) => [e.key, e.data.group_address, e.data.value, e.data.device]),
    [
      [SCENE_TRIGGERS.GROUP_VALUE, '1/1/1', '1', 'ext:knx:light:living-room'],
      [SCENE_TRIGGERS.GROUP_VALUE, '7/1/1', '1', null],
      [SCENE_TRIGGERS.GROUP_VALUE, '4/2/1', '397', 'ext:knx:sensor:meter'],
    ],
  );
  assert.equal(events[0].data.source, '1.1.5');
  // The same telegram repeated by the bus within a second: no second event.
  gateway.indicate(indication({ to: '7/1/1', value: 1 }));
  await clock.advance(0);
  assert.equal(gladys.fake.sceneEvents.length, 3);
  // The meter again 10 s later: the state waits for its 30 s slot, the latest value wins.
  await clock.advance(10_000);
  gateway.indicate(indication({ to: '4/2/1', value: '42380000' }));
  gateway.indicate(indication({ to: '4/2/1', value: '42ef0000' }));
  await clock.advance(0);
  assert.equal(gladys.fake.lastState('ext:knx:sensor:meter:power'), 397);
  await clock.advance(20_000);
  assert.equal(gladys.fake.lastState('ext:knx:sensor:meter:power'), 119.5);
  const widget = (await gladys.fake.widgetGet(WIDGETS.BUS, { language: 'en' })).data.content;
  const list = widget.components.find((c) => c.type === 'card-list');
  assert.equal(list.items[0].title, '4/2/1 → 119.5');
  assert.equal(list.items.at(-1).subtitle, 'Living room · from 1.1.5');
  assert.ok(gladys.fake.widgetRefreshes.length >= 1);
});

test('commands: light, shutter, thermostat, each as group writes; errors are clear', async () => {
  const { gladys, clock, gateway } = await setup();
  await clock.advance(2000);
  const before = gateway.requests.length;
  const act = async (id, feature, value) => {
    const pending = gladys.fake.setValue(
      { external_id: `ext:knx:${id}`, name: id },
      { external_id: `ext:knx:${id}:${feature}` },
      value,
    );
    await clock.advance(500);
    return pending;
  };
  assert.equal((await act('light:living-room', 'switch', 1)).success, true);
  assert.equal((await act('shutter:bedroom', 'control', -1)).success, true);
  assert.equal((await act('shutter:bedroom', 'control', 0)).success, true);
  assert.equal((await act('shutter:bedroom', 'position', 25)).success, true);
  assert.equal((await act('thermostat:office', 'setpoint', 21.5)).success, true);
  assert.equal((await act('thermostat:office', 'mode', 3)).success, true);
  assert.deepEqual(sentTo(gateway).slice(before), [
    ['1/1/1', '0081'],
    ['2/1/1', '0081'],
    ['2/1/2', '0081'],
    ['2/1/3', '0080bf'],
    ['5/1/1', '00800c33'],
    ['5/1/4', '008002'],
  ]);
  // Our own write updates the state of the devices listening to that address.
  assert.equal(gladys.fake.lastState('ext:knx:light:living-room:switch'), 1);
  assert.equal(gladys.fake.sceneEvents.length, 0, 'our own writes fire no event');
  const readOnly = await act('sensor:meter', 'power', 3);
  assert.equal(readOnly.success, false);
  assert.match(readOnly.error, /accepts no command/);
  const gone = await act('light:attic', 'switch', 1);
  assert.match(gone.error, /no longer in the KNX device list/);
});

test('scene action "send a group value": every DPT option, invalid input refused', async () => {
  const { gladys, clock, gateway } = await setup();
  await clock.advance(2000);
  const send = async (fields) => {
    const pending = gladys.fake.sceneAction(SCENE_ACTIONS.SEND, fields);
    await clock.advance(500);
    return pending;
  };
  const sent = await send({ group_address: '5/1/1', dpt: '9', value: '21.5' });
  assert.deepEqual(sent.data.outputs, { group_address: '5/1/1', raw: '0c33' });
  assert.equal((await send({ group_address: '7/1/1', dpt: '1', value: 'on' })).success, true);
  assert.equal((await send({ group_address: '7/1/2', dpt: '3.007', value: '-2' })).success, true);
  assert.equal(
    (await send({ group_address: '7/257', dpt: '18.001', value: 'learn 5' })).success,
    true,
  );
  assert.equal((await send({ group_address: '7/1/4', dpt: 'raw', value: '01 02' })).success, true);
  assert.deepEqual(sentTo(gateway).slice(-5), [
    ['5/1/1', '00800c33'],
    ['7/1/1', '0081'],
    ['7/1/2', '0082'],
    ['7/1/1', '008084'],
    ['7/1/4', '00800102'],
  ]);
  const bad = await send({ group_address: '7/1/9', dpt: '5.001', value: '120' });
  assert.equal(bad.success, false);
  assert.match(bad.error, /out of range 0..100/);
  assert.match(
    (await send({ group_address: '0/0/0', dpt: '1', value: '1' })).error,
    /not a group address/,
  );
  assert.match(
    (await send({ group_address: '1/1/1', dpt: '16', value: 'x' })).error,
    /Unknown DPT/,
  );
});

test('a new device list keeps the tunnel; a new gateway opens a new one', async () => {
  const { app, gladys, clock, gateway } = await setup();
  await clock.advance(2000);
  await app.start({ ...CONFIG, devices: `${DEVICES}\nswitch; Pump; switch=3/1/1; state=3/1/2` });
  await clock.advance(0);
  assert.equal(gateway.received(0x0205).length, 1, 'still the first tunnel');
  assert.equal(gladys.fake.discoveredDevices.length, 5);
  await gladys.fake.deviceCreated(created('switch:pump', 'Pump'));
  await clock.advance(1500);
  assert.deepEqual(sentTo(gateway).at(-1), ['3/1/2', '0000'], 'the new device is read at once');
  assert.match(gladys.fake.connectionStatus.message.en, /5 devices declared, 5 created/);
  await app.start({ ...CONFIG, host: '192.168.1.11' });
  await clock.advance(0);
  assert.equal(gateway.received(0x0209).length, 1, 'the old tunnel was closed');
  assert.equal(gateway.received(0x0205).length, 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(gladys.fake.connectionStatus.message.en, /192\.168\.1\.11/);
});

test('the Test button: while connected only the description; a dead gateway is explained', async () => {
  const { gladys, clock, gateway } = await setup();
  const result = await gladys.fake.action(ACTIONS.TEST);
  assert.match(result.data.message.en, /The gateway answers: "KNX\/IP-Router"/);
  assert.match(result.data.message.en, /tunnel is open as 1\.1\.255/);
  assert.equal(gateway.received(0x0205).length, 1, 'no second tunnel');
  await running.stop();
  gateway.down = true;
  const pending = gladys.fake.action(ACTIONS.TEST);
  await clock.advance(15_000);
  const failed = await pending;
  assert.match(
    failed.data.message.fr,
    /La passerelle 192\.168\.1\.10 est inutilisable : pas de réponse/,
  );
});

test('an unreachable gateway: the status says why and when the next attempt comes', async () => {
  const { gladys, clock, gateway } = await setup({ start: false });
  gateway.down = true;
  await running.start(CONFIG);
  await clock.advance(14_000);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /KNX gateway 192\.168\.1\.10 unreachable: no answer .*Next attempt in 2 s\./,
  );
  const failed = await gladys.fake.setValue(
    { external_id: 'ext:knx:light:living-room' },
    { external_id: 'ext:knx:light:living-room:switch' },
    1,
  );
  assert.match(failed.error, /not connected/);
  gateway.down = false;
  await clock.advance(2000);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  const widget = (await gladys.fake.widgetGet(WIDGETS.BUS, { language: 'fr' })).data.content;
  assert.equal(widget.components[0].items[0].value, 'KNX/IP-Router');
});
