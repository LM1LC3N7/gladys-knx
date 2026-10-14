// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ACTIONS,
  ADDRESS_STYLES,
  EVENT_KEYS,
  PROTOCOLS,
  SCENE_ACTIONS,
  SCENE_TRIGGERS,
  SEND_DPTS,
  WIDGETS,
} from '../src/constants.js';
import { DEFAULTS } from '../src/config.js';
import { DEVICE_TYPES } from '../src/devices.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const index = read('index.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) {
      yield* texts(item, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

test('the store basics', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.location, undefined, 'no house location needed');
  assert.deepEqual(manifest.transports, ['local']);
  assert.match(manifest.gladys_version, />=5\.1\.0/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-knx:${manifest.version}`);
  assert.equal(manifest.version, JSON.parse(read('package.json')).version);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /non officiel/);
  const intro = manifest.config_schema.find((f) => f.type === 'section');
  assert.match(intro.description.en, /not affiliated with the KNX Association/);
  for (const link of intro.links) {
    assert.match(link.url, /^https:\/\//);
  }
});

test('every text is bilingual', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
});

test('the configuration matches the code', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.ok(fields[key], `${key} is in the manifest`);
    if (value === '') {
      assert.equal(fields[key].default, undefined, key);
    } else {
      assert.equal(fields[key].default, value, key);
    }
  }
  assert.deepEqual(
    fields.protocol.options.map((o) => o.value),
    PROTOCOLS,
  );
  assert.deepEqual(
    fields.address_style.options.map((o) => o.value),
    ADDRESS_STYLES,
  );
  // The field description names every type and key of the grammar.
  for (const [type, spec] of Object.entries(DEVICE_TYPES)) {
    for (const word of [type, ...Object.keys(spec.keys), ...spec.flags]) {
      assert.ok(fields.devices.description.en.includes(word), `${word} in the en description`);
      assert.ok(fields.devices.description.fr.includes(word), `${word} in the fr description`);
    }
  }
});

test('the keys of the manifest are the keys of the code', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  assert.deepEqual(
    manifest.scene_actions.map((a) => a.key).sort(),
    Object.values(SCENE_ACTIONS).sort(),
  );
  assert.deepEqual(
    manifest.scene_triggers.map((t) => t.key).sort(),
    Object.values(SCENE_TRIGGERS).sort(),
  );
  assert.deepEqual(manifest.widgets.map((w) => w.key).sort(), Object.values(WIDGETS).sort());
  for (const name of Object.keys(SCENE_ACTIONS)) {
    assert.ok(index.includes(`onSceneAction(SCENE_ACTIONS.${name}`), name);
  }
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(index.includes(`onAction(ACTIONS.${name}`), name);
  }
  const [trigger] = manifest.scene_triggers;
  const keys = new Set([...trigger.fields, ...trigger.variables].map((f) => f.key));
  assert.deepEqual([...keys].sort(), [...EVENT_KEYS].sort(), 'every event key is declared');
  const [action] = manifest.scene_actions;
  assert.deepEqual(
    action.fields.find((f) => f.key === 'dpt').options.map((o) => o.value),
    SEND_DPTS,
  );
  assert.deepEqual(
    action.outputs.map((o) => o.key),
    ['group_address', 'raw'],
  );
});
