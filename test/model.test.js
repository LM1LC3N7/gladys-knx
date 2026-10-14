// -----------------------------------------------------------------------------
// The pure parts: the device grammar, the devices, the conversions between the
// bus and Gladys, the scene events and the widget.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { normalizeConfig, parseDevices } from '../src/config.js';
import { SCENE_TRIGGERS } from '../src/constants.js';
import { BINARIES, SENSORS, buildDevice, parseExternalId, slugOf } from '../src/devices.js';
import { errorsSummary, grammarError } from '../src/i18n.js';
import { small, data } from '../src/knx/dpt.js';
import { commandsOf, listenersOf, readAddresses, stateOf } from '../src/model.js';
import { EventGate, groupValueEvent } from '../src/triggers.js';
import { busWidget } from '../src/widget.js';
import { ga } from './helpers/fakeGateway.js';

const gladys = { externalId: (suffix) => `ext:knx:${suffix}` };

const LIST = `
# ground floor
light; Living room; switch=1/1/1; state=1/1/2
dimmer; Kitchen; switch=1/2/1; brightness=1/2/3; brightness_state=1/2/4
shutter; Bedroom; move=2/1/1; stop=2/1/2; position=2/1/3; position_state=2/1/4
shutter; Bathroom; move=2/2/1; position=2/2/3; invert
switch; Pump; switch=3/1/1, sensor; Office; temperature=4/1/1; humidity=4/1/2@5.001; lux=4/1/3
sensor; Meter; power=4/2/1@9.024; energy=4/2/2; counter=4/2/3@13.001
thermostat; Office; setpoint=5/1/1; setpoint_state=5/1/2; temperature=5/1/3; mode=5/1/4; heating=5/1/5
binary; Window; contact=6/1/1
binary; Door; contact=6/1/2; invert
binary; Hall; motion=6/2/1; presence=3329
`;

const byName = (definitions) => Object.fromEntries(definitions.map((d) => [d.id, d]));

test('the device grammar: every type, the three address styles, DPTs, flags, comments', () => {
  const { definitions, errors } = parseDevices(LIST);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    definitions.map((d) => d.id),
    [
      'light:living-room',
      'dimmer:kitchen',
      'shutter:bedroom',
      'shutter:bathroom',
      'switch:pump',
      'sensor:office',
      'sensor:meter',
      'thermostat:office',
      'binary:window',
      'binary:door',
      'binary:hall',
    ],
  );
  const d = byName(definitions);
  assert.deepEqual(d['light:living-room'].addresses, {
    switch: { ga: ga('1/1/1'), dpt: '1.001' },
    state: { ga: ga('1/1/2'), dpt: '1.001' },
  });
  assert.equal(d['shutter:bathroom'].invert, true);
  assert.deepEqual(d['sensor:office'].addresses.humidity, {
    ga: ga('4/1/2'),
    dpt: '5.001',
    custom: true,
  });
  assert.equal(d['sensor:office'].addresses.illuminance.dpt, '9.004', 'lux is an alias');
  assert.equal(d['sensor:meter'].addresses.energy.dpt, '13.010');
  assert.equal(d['binary:hall'].addresses.presence.ga, ga('1/5/1'), 'free style 3329');
  assert.equal(d['binary:window'].index, 9, 'comments are not counted');
  // The id comes from the type and the name: the order of the lines does not matter.
  const reversed = parseDevices(LIST.split('\n').reverse().join('\n'));
  assert.deepEqual(
    reversed.definitions.map((x) => x.id).sort(),
    definitions.map((x) => x.id).sort(),
  );
  assert.equal(slugOf('Salle de bain (étage)'), 'salle-de-bain-etage');
});

test('the device grammar: one clear error per broken device, the others still work', () => {
  const { definitions, errors } = parseDevices(
    [
      'lamp; Hall; switch=1/1/1',
      'heater; Hall; switch=1/1/1',
      'light; switch=1/1/1',
      'light; Desk; switch=1/1/1; colour=1/1/9',
      'light; Desk 2; switch=1/1/1; switch=1/1/2',
      'light; Desk 3; switch=32/1/1',
      'light; Desk 4; switch=0/0/0',
      'sensor; Desk 5; temperature=1/1/1@9.007',
      'shutter; Desk 6; stop=1/1/1',
      'light; HALL; switch=1/1/5',
      'light; Desk 7; switch=1/1/1; invert',
    ].join('\n'),
  );
  assert.deepEqual(
    definitions.map((d) => d.id),
    ['light:hall'],
    '"lamp" is an alias of light',
  );
  assert.deepEqual(
    errors.map((e) => [e.index, e.code]),
    [
      [2, 'type'],
      [3, 'name'],
      [4, 'key'],
      [5, 'duplicate_key'],
      [6, 'address'],
      [7, 'address'],
      [8, 'dpt'],
      [9, 'missing'],
      [10, 'duplicate'],
      [11, 'key'],
    ],
  );
  assert.match(grammarError(errors[0]).en, /Device #2: unknown type "heater"/);
  assert.match(grammarError(errors[2]).fr, /« colour » est inconnu pour ce type \(switch, state\)/);
  assert.match(grammarError(errors[5]).en, /0\/0\/0 is the broadcast address/);
  assert.match(grammarError(errors[6]).en, /DPT 9.007 is not available here \(9.001, 14.068\)/);
  assert.match(errorsSummary(errors).en, /And 8 more\./);
});

test('normalizeConfig: the gateway address, the protocol, the event filter', () => {
  const config = normalizeConfig({
    host: ' udp://192.168.1.20:3700/ ',
    protocol: 'TCP',
    address_style: 'two_level',
    event_addresses: '7/1/1, 7/1/2 bogus',
  });
  assert.equal(config.host, '192.168.1.20');
  assert.equal(config.port, 3700);
  assert.equal(config.protocol, 'tcp');
  assert.equal(config.addressStyle, 'two_level');
  assert.deepEqual([...config.eventAddresses], [ga('7/1/1'), ga('7/1/2')]);
  assert.deepEqual(config.invalidEventAddresses, ['bogus']);
  const defaults = normalizeConfig({ host: 'knx.local', port: '99999', protocol: 'x' });
  assert.equal(defaults.port, 3671);
  assert.equal(defaults.protocol, 'udp');
  assert.equal(defaults.eventAddresses, undefined);
});

test('the Gladys devices: features, feedback, read-only, the shutter command, the presets', () => {
  const d = byName(parseDevices(LIST).definitions);
  const light = buildDevice(gladys, d['light:living-room']);
  assert.equal(light.external_id, 'ext:knx:light:living-room');
  assert.deepEqual(parseExternalId(light.external_id), {
    type: 'light',
    slug: 'living-room',
    id: 'light:living-room',
  });
  assert.equal(parseExternalId(`${light.external_id}:switch`), undefined);
  assert.deepEqual(
    light.features.map((f) => [f.external_id, f.category, f.type, f.read_only, f.has_feedback]),
    [['ext:knx:light:living-room:switch', 'light', 'binary', false, true]],
  );
  assert.deepEqual(light.params[1], { name: 'addresses', value: 'switch=1/1/1, state=1/1/2' });
  const shutter = buildDevice(gladys, d['shutter:bathroom']);
  assert.deepEqual(
    shutter.features.map((f) => [f.type, f.has_feedback]),
    [
      ['state', false],
      ['position', false],
    ],
  );
  const thermostat = buildDevice(gladys, d['thermostat:office']);
  const mode = thermostat.features.find((f) => f.external_id.endsWith(':mode'));
  assert.deepEqual(
    mode.supported_options.map((o) => o.value),
    [0, 5, 3, 4, 1],
  );
  const meter = buildDevice(gladys, d['sensor:meter']);
  assert.deepEqual(
    meter.features.map((f) => [f.type, f.unit ?? null]),
    [
      ['power', 'watt'],
      ['index', 'kilowatt-hour'],
      ['integer', null],
    ],
  );
  assert.equal(meter.params[1].value, 'power=4/2/1@9.024, energy=4/2/2, counter=4/2/3@13.001');
  // Every sensor and binary key makes a named feature.
  const every = parseDevices(
    [
      `sensor; All; ${Object.keys(SENSORS)
        .map((k, i) => `${k}=8/1/${i + 1}`)
        .join('; ')}`,
      `binary; All; ${Object.keys(BINARIES)
        .map((k, i) => `${k}=8/2/${i + 1}`)
        .join('; ')}`,
    ].join('\n'),
  ).definitions;
  for (const definition of every) {
    for (const feature of buildDevice(gladys, definition).features) {
      assert.ok(feature.name, feature.external_id);
    }
  }
  assert.deepEqual(
    readAddresses(d['shutter:bedroom']),
    [ga('2/1/4')],
    'only the status addresses are read',
  );
});

test('bus -> Gladys: shutter direction, contacts, presets, units', () => {
  const d = byName(parseDevices(LIST).definitions);
  assert.deepEqual(stateOf(d['shutter:bedroom'], 'position_state', 30), {
    feature: 'position',
    value: 70,
  });
  assert.equal(stateOf(d['shutter:bedroom'], 'position', 30), undefined, 'a target, not a state');
  assert.deepEqual(stateOf(d['shutter:bathroom'], 'position', 30), {
    feature: 'position',
    value: 30,
  });
  assert.equal(stateOf(d['shutter:bedroom'], 'move', 1), undefined);
  assert.deepEqual(stateOf(d['binary:window'], 'contact', 1), { feature: 'contact', value: 0 });
  assert.deepEqual(stateOf(d['binary:door'], 'contact', 1), { feature: 'contact', value: 1 });
  assert.deepEqual(stateOf(d['thermostat:office'], 'mode_state', 'standby'), {
    feature: 'mode',
    value: 3,
  });
  assert.deepEqual(stateOf(d['thermostat:office'], 'temperature', 21.74), {
    feature: 'temperature',
    value: 21.74,
  });
  assert.deepEqual(stateOf(d['sensor:meter'], 'power', 1.5), { feature: 'power', value: 1500 });
  assert.deepEqual(stateOf(d['sensor:meter'], 'energy', 123456), {
    feature: 'energy',
    value: 123.456,
  });
  assert.deepEqual(stateOf(d['light:living-room'], 'state', 1), { feature: 'switch', value: 1 });
  const listeners = listenersOf(Object.values(d));
  assert.equal(listeners.get(ga('5/1/3'))[0].key, 'temperature');
});

test('Gladys -> bus: the writes of every command', () => {
  const d = byName(parseDevices(LIST).definitions);
  const one = (definition, feature, value) =>
    commandsOf(definition, feature, value).map((c) => [c.key, c.ga, c.dpt, c.value]);
  assert.deepEqual(one(d['light:living-room'], 'switch', 1), [['switch', ga('1/1/1'), '1.001', 1]]);
  assert.deepEqual(one(d['dimmer:kitchen'], 'brightness', 40), [
    ['brightness', ga('1/2/3'), '5.001', 40],
  ]);
  // Open = up (0), close = down (1); `invert` swaps them.
  assert.deepEqual(one(d['shutter:bedroom'], 'control', 1), [['move', ga('2/1/1'), '1.008', 0]]);
  assert.deepEqual(one(d['shutter:bedroom'], 'control', -1), [['move', ga('2/1/1'), '1.008', 1]]);
  assert.deepEqual(one(d['shutter:bathroom'], 'control', 1), [['move', ga('2/2/1'), '1.008', 1]]);
  assert.deepEqual(one(d['shutter:bedroom'], 'control', 0), [['stop', ga('2/1/2'), '1.017', 1]]);
  assert.deepEqual(one(d['shutter:bedroom'], 'position', 100), [
    ['position', ga('2/1/3'), '5.001', 0],
  ]);
  assert.deepEqual(one(d['thermostat:office'], 'mode', 4), [
    ['mode', ga('5/1/4'), '20.102', 'economy'],
  ]);
  assert.deepEqual(one(d['thermostat:office'], 'setpoint', 21.5), [
    ['setpoint', ga('5/1/1'), '9.001', 21.5],
  ]);
  assert.throws(() => commandsOf(d['shutter:bathroom'], 'control', 0), /no "stop" address/);
  assert.throws(() => commandsOf(d['binary:window'], 'contact', 1), /accepts no command/);
});

test('the scene event: only writes, decoded for declared addresses, raw otherwise', () => {
  const definitions = parseDevices(LIST).definitions;
  const options = {
    listeners: listenersOf(definitions),
    deviceIdOf: (definition) => `ext:knx:${definition.id}`,
    style: 'three_level',
  };
  const declared = groupValueEvent(
    { service: 'write', ga: ga('5/1/4'), source: 0x1116, payload: data([0x01]) },
    options,
  );
  assert.equal(declared.key, SCENE_TRIGGERS.GROUP_VALUE);
  assert.deepEqual(declared.data, {
    group_address: '5/1/4',
    device: 'ext:knx:thermostat:office',
    device_name: 'Office',
    value: 'comfort',
    number: 1,
    raw: '01',
    dpt: '20.102',
    source: '1.1.22',
  });
  const button = groupValueEvent(
    { service: 'write', ga: ga('7/1/1'), source: 0x1101, payload: small(1) },
    { ...options, style: 'two_level' },
  );
  assert.deepEqual(
    [button.data.group_address, button.data.value, button.data.number, button.data.device],
    ['7/257', '1', 1, null],
  );
  const unknown = groupValueEvent(
    { service: 'write', ga: ga('7/1/2'), source: 0x1101, payload: data([0x0c, 0x1a]) },
    options,
  );
  assert.deepEqual([unknown.data.value, unknown.data.number], ['0c1a', null]);
  assert.equal(
    groupValueEvent(
      { service: 'response', ga: ga('5/1/4'), source: 1, payload: data([1]) },
      options,
    ),
    undefined,
    'an answer to a read is no event',
  );
  assert.equal(
    groupValueEvent(
      { service: 'write', ga: ga('7/1/1'), source: 1, payload: small(1) },
      { ...options, eventAddresses: new Set([ga('7/1/2')]) },
    ),
    undefined,
  );
});

test('the event gate: a bus repetition within a second is dropped, 120 events a minute', () => {
  let now = 0;
  const gate = new EventGate({ now: () => now });
  const event = (value) => ({ data: { group_address: '7/1/1', raw: value, source: '1.1.1' } });
  assert.equal(gate.admit(event('01')), true);
  now = 300;
  assert.equal(gate.admit(event('01')), false, 'the same telegram again');
  assert.equal(gate.admit(event('00')), true, 'another value passes');
  now = 2000;
  assert.equal(gate.admit(event('00')), true, 'a second later is a new press');
  let admitted = 0;
  for (let i = 0; i < 200; i += 1) {
    admitted += gate.admit({ data: { group_address: `1/1/${i}`, raw: '01', source: '1.1.1' } })
      ? 1
      : 0;
  }
  assert.equal(admitted, 117);
  assert.equal(gate.dropped, 83);
  now = 63_000;
  assert.equal(gate.admit(event('01')), true, 'a new minute');
});

test('the bus monitor widget fits the core vocabulary', () => {
  const empty = busWidget({ connected: false, received: 0, declared: 3, created: 0 });
  assert.deepEqual(validateWidgetContent(empty), []);
  assert.equal(empty.components[0].items[0].color, 'danger');
  const telegrams = Array.from({ length: 12 }, (_, i) => ({
    at: '2026-10-14T08:00:00.000Z',
    groupAddress: `1/1/${i}`,
    deviceName: i % 2 ? 'Living room' : undefined,
    value: String(i),
    service: ['write', 'response', 'read'][i % 3],
    source: '1.1.22',
  }));
  const full = busWidget({
    connected: true,
    gatewayName: 'KNX/IP-Router',
    address: '1.1.255',
    received: 42,
    declared: 3,
    created: 2,
    telegrams,
    language: 'fr',
  });
  assert.deepEqual(validateWidgetContent(full), []);
  const list = full.components.find((c) => c.type === 'card-list');
  assert.equal(list.items.length, 8);
  assert.equal(list.items[0].subtitle, 'adresse non déclarée · de 1.1.22');
  assert.equal(list.items[0].badge.text, 'Écriture');
  assert.match(full.components.at(-1).text.en, /Unofficial connector, not affiliated with the KNX/);
});
