// -----------------------------------------------------------------------------
// The DPT codecs. The expected bytes are the ones of the xknx test suite
// (test/dpt_tests, main branch of 2026-10-14), which follows KNX 03.07.02.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DptError,
  data,
  decode,
  encode,
  parseHex,
  parseValue,
  payloadHex,
  roundHalfEven,
  small,
  valueNumber,
  valueText,
} from '../src/knx/dpt.js';

const bytes = (payload) => payloadHex(payload);
const raw = (hexText) => data(Buffer.from(hexText, 'hex'));

test('DPT 9 (two-octet float): the xknx vectors both ways', () => {
  const both = [
    [-30, '8a24'],
    [16.96, '06a0'],
    [0, '0000'],
    [21, '0c1a'],
    [-10, '8418'],
    [20.48, '0c00'],
    [-20.48, '8000'],
    [499.84, '2e1a'],
    [500.16, '2e1b'],
    [-999.68, 'b1e6'],
    [-1000.32, 'b1e5'],
    [670433.28, '7ffe'],
    [-671088.64, 'f800'],
  ];
  for (const [value, hexText] of both) {
    assert.equal(bytes(encode('9.001', value)), hexText, `encode ${value}`);
    assert.equal(decode('9.001', raw(hexText)), value, `decode ${hexText}`);
  }
  // Encoded to the nearest representable value.
  assert.equal(bytes(encode('9', 500)), '2e1a');
  assert.equal(bytes(encode('9', -1000)), 'b1e6');
  // Near zero, as ETS does: never 8000h (that is -20.48).
  assert.equal(bytes(encode('9', 0.0002)), '0000');
  assert.equal(bytes(encode('9', 0.005)), '0000', 'half-to-even, as Python rounds');
  assert.equal(bytes(encode('9', 0.00501)), '0001');
  assert.equal(bytes(encode('9', -0.005)), '0000');
  assert.equal(bytes(encode('9', -0.00501)), '87ff');
  assert.equal(decode('9', raw('87ff')), -0.01);
  // A real telegram of the xknx tunnel tests: 21.74 °C.
  assert.equal(decode('9.001', raw('0c3f')), 21.74);
  // 7FFFh is "invalid data"; out of range values are refused.
  assert.throws(() => decode('9', raw('7fff')), DptError);
  assert.throws(() => encode('9', 670760.96), DptError);
  assert.throws(() => decode('9', raw('f80123')), DptError);
  // 2047.5 rounds to 2048, which needs the next exponent (xknx wraps it to 0).
  assert.equal(decode('9', encode('9', 20.475)), 20.48);
});

test('DPT 5.001, 5.010 and 17.001 / 18.001: the xknx vectors', () => {
  for (const [hexText, value] of [
    ['4c', 30],
    ['fc', 99],
    ['ff', 100],
    ['00', 0],
  ]) {
    assert.equal(bytes(encode('5.001', value)), hexText);
    assert.equal(decode('5.001', raw(hexText)), value);
  }
  assert.equal(bytes(encode('5.001', 50)), '80', '127.5 -> 128 (even)');
  assert.throws(() => encode('5.001', 101), DptError);
  assert.throws(() => encode('5.001', 'fnord'), DptError);
  assert.equal(bytes(encode('5.010', 200)), 'c8');
  assert.equal(decode('5.010', raw('c8')), 200);
  for (const [hexText, scene] of [
    ['31', 50],
    ['3f', 64],
    ['00', 1],
  ]) {
    assert.equal(bytes(encode('17.001', scene)), hexText);
    assert.equal(decode('17.001', raw(hexText)), scene);
  }
  assert.throws(() => decode('17.001', raw('64')), DptError);
  for (const [value, hexText] of [
    [{ scene: 1, learn: false }, '00'],
    [{ scene: 1, learn: true }, '80'],
    [{ scene: 64, learn: false }, '3f'],
    [{ scene: 64, learn: true }, 'bf'],
    [{ scene: 17, learn: false }, '10'],
    [{ scene: 21, learn: true }, '94'],
  ]) {
    assert.equal(bytes(encode('18.001', value)), hexText);
    assert.deepEqual(decode('18.001', raw(hexText)), value);
  }
  assert.throws(() => encode('18.001', { scene: 65, learn: true }), DptError);
  assert.throws(() => decode('18.001', raw('ff4e')), DptError);
});

test('DPT 1, 3.007 and 20.102: small values and the HVAC modes', () => {
  assert.deepEqual(encode('1.001', true), small(1));
  assert.deepEqual(encode('1.001', 0), small(0));
  assert.equal(decode('1.001', small(1)), 1);
  // xknx: every 4-bit value round-trips, bit 3 the direction, bits 0-2 the step.
  for (let rawValue = 0; rawValue < 16; rawValue += 1) {
    const value = { increase: Boolean(rawValue >> 3), step: rawValue & 0x07 };
    assert.deepEqual(encode('3.007', value), small(rawValue));
    assert.deepEqual(decode('3.007', small(rawValue)), value);
  }
  const modes = ['auto', 'comfort', 'standby', 'economy', 'building_protection'];
  modes.forEach((mode, index) => {
    assert.equal(bytes(encode('20.102', mode)), `0${index}`);
    assert.equal(decode('20.102', raw(`0${index}`)), mode);
  });
  assert.throws(() => decode('20.102', raw('05')), DptError);
  assert.throws(() => decode('20.102', raw('0102')), DptError);
});

test('DPT 13 and 14: four octets, big-endian; DPT 14 read back with 7 digits', () => {
  assert.equal(bytes(encode('13.010', 2147483647)), '7fffffff');
  assert.equal(bytes(encode('13.010', -2147483648)), '80000000');
  assert.equal(bytes(encode('13.013', 1234)), '000004d2');
  assert.equal(decode('13.013', raw('fffffb2e')), -1234);
  assert.throws(() => encode('13', 2147483648), DptError);
  for (const [value, hexText] of [
    [397, '43c68000'],
    [46, '42380000'],
    [119.5, '42ef0000'],
    [229.89, '4365e3d7'],
    [0, '00000000'],
  ]) {
    assert.equal(bytes(encode('14.056', value)), hexText);
    assert.equal(decode('14.056', raw(hexText)), value);
  }
  assert.equal(bytes(encode('14', 0.945000052452)), '3f71eb86');
  assert.equal(decode('14', raw('3f71eb86')), 0.9450001);
  assert.ok(Number.isNaN(decode('14', raw('7fc00000'))));
  assert.equal(roundHalfEven(2.5), 2);
  assert.equal(roundHalfEven(-1.5), -2);
  assert.equal(roundHalfEven(3.5), 4);
});

test('the text typed in the scene action, and the event value', () => {
  assert.equal(parseValue('1', 'ON'), 1);
  assert.equal(parseValue('1', 'down'), 1, '1.008: down is 1');
  assert.equal(parseValue('1', 'up'), 0);
  assert.throws(() => parseValue('1', 'maybe'), DptError);
  assert.deepEqual(parseValue('3.007', '+3'), { increase: true, step: 3 });
  assert.deepEqual(parseValue('3.007', '-'), { increase: false, step: 1 });
  assert.deepEqual(parseValue('3.007', 'stop'), { increase: false, step: 0 });
  assert.throws(() => parseValue('3.007', '+9'), DptError);
  assert.deepEqual(parseValue('18.001', 'learn 5'), { learn: true, scene: 5 });
  assert.equal(parseValue('20.102', 'Building protection'), 'building_protection');
  assert.equal(parseValue('20.102', 'frost'), 'building_protection');
  assert.equal(parseValue('20.102', '1'), 'comfort');
  assert.equal(parseValue('9', ' 21.5 '), 21.5);
  assert.throws(() => parseValue('9', 'warm'), DptError);
  assert.equal(bytes(parseHex('0x0C 1A')), '0c1a');
  assert.throws(() => parseHex('abc'), DptError);
  assert.throws(() => parseHex(''), DptError);
  assert.equal(valueText('3.007', { increase: false, step: 2 }), '-2');
  assert.equal(valueNumber('3.007', { increase: false, step: 2 }), -2);
  assert.equal(valueText('18.001', { learn: true, scene: 4 }), 'learn 4');
  assert.equal(valueText('20.102', 'comfort'), 'comfort');
  assert.equal(valueNumber('20.102', 'comfort'), 1);
  assert.equal(valueText('9.001', 21.74), '21.74');
});
