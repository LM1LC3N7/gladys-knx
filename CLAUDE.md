# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.15). It
speaks **KNXnet/IP tunnelling** (UDP, or TCP for KNXnet/IP 2) to a KNX IP
interface or router on the LAN, hand-written from the KNX specification as
xknx implements it: the devices typed in a `devices` field (lights, dimmers,
shutters, switches, sensors, thermostats, binary sensors, by group address),
their states followed on the bus, the commands as group writes, a "group
value received" scene trigger, a "send a group value" scene action, a bus
monitor widget. Local only. Unofficial: not affiliated with the KNX
Association.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/tunnel.test.js           # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run audit                             # npm audit --omit=dev
npx github:GladysAssistant/integration-store .   # store admission checks
```

Run `format:check`, `lint`, `test` and `audit` before every commit.

## Architecture

```
index.js              SDK wiring only (handlers registered before connect())
src/app.js            KnxApp: devices, tunnel lifecycle, bus -> states and
                      events, commands, scene action, widget, Test button
src/knx/transport.js  the ONLY network access: one dgram socket or one net
                      connection, from a socket factory
src/knx/tunnel.js     the tunnel client: connect, heartbeat, sequence
                      counters, ACK / repeat, L_Data.con, send queue, probe
src/knx/frames.js     KNXnet/IP frames: header, HPAI, CRI/CRD, DIBs (pure)
src/knx/cemi.js       cEMI L_Data frames, TPCI/APCI group services (pure)
src/knx/dpt.js        DPT 1, 3.007, 5, 9, 13, 14, 17, 18, 20.102 (pure)
src/knx/address.js    group and individual addresses (pure)
src/devices.js        device types, keys, DPTs, FEATURE keys, Gladys devices (pure)
src/model.js          bus value <-> Gladys state, command -> writes (pure)
src/triggers.js       telegram -> scene event, EventGate (pure)
src/widget.js         the "bus_monitor" widget (pure)
src/publisher.js      states to Gladys, measurements throttled
src/config.js         config_schema normalized, the `devices` grammar
src/constants.js      timings, pacing, limits, manifest keys
src/i18n.js           runtime texts (en/fr), grammar errors
test/helpers/         a byte-level fake gateway behind the socket factories,
                      a fake clock; Gladys is the SDK's fake
```

## Rules

- **Unofficial.** Every user-facing surface says "unofficial connector, not
  affiliated with the KNX Association". Never use the KNX logo.
- **Keys are forever**: the manifest keys and the DPT options of the action
  (`src/constants.js`), the device types and their keys (`DEVICE_TYPES`), the
  feature keys (`FEATURE` and the sensor / binary keys in `src/devices.js`),
  the external id shape `<type>:<slug of the name>` (`slugOf`) and the event
  keys (`EVENT_KEYS`) are stored in user configurations, scenes and
  dashboards. Never rename them.
- **The device list is the truth**: KNX has no discovery, so a device is its
  line in `devices`. Its id comes from the type and the name (reordering
  changes nothing; a rename is a new device, documented); its addresses are
  read from the configuration, never from the device params (which only
  display them).
- **The protocol follows the specification byte for byte**: every frame
  layout and DPT codec is tested against the frames and vectors of the xknx
  test suite (`test/knx.test.js`, `test/dpt.test.js`), and the fake gateway
  (`test/helpers/fakeGateway.js`) is written by hand from the specification,
  never with the encoders of `src/knx/`. A change of encoding needs a vector.
- **Behind Docker's NAT**: always the route-back HPAI (0.0.0.0:0); routing
  (multicast 224.0.23.12) cannot reach the container and is not offered.
  UDP datagrams are accepted from the gateway's address only.
- **Be gentle with the bus and with Gladys** (`PACING`, `TIMING`):
  - one telegram at a time: TUNNELLING_ACK within 1 s (UDP), one repeat with
    the same sequence counter, then DISCONNECT and a new tunnel; then the
    L_Data.con (3 s at most, a missing one is tolerated) before the next;
  - 100 ms after a write, 250 ms after a read; commands go before the reads
    still queued; a read already queued or on its way is not queued again;
    200 telegrams waiting at most; a command while the tunnel is down fails
    at once (never delivered minutes later);
  - the status addresses of the created devices are read once per
    connection and when a device is created, never polled;
  - CONNECTIONSTATE every 60 s, 10 s to answer, three failures rebuild the
    tunnel; reconnection after 2 s doubling up to 60 s, 60 s when every
    tunnel of the gateway is taken (E_NO_MORE_CONNECTIONS);
  - measurements reach Gladys at most every 30 s per feature (the latest
    value wins), switches and positions at once (`src/publisher.js`).
- **Events** (`src/triggers.js`): only a GroupValue_Write fires
  `group_value_received`; the answers to reads (the start-up sweep among
  them) only update states, and our own writes come back as L_Data.con, never
  as an indication: no scene loop. The same telegram within 1 s fires once,
  120 events a minute at most. The core matches fields by equality: the
  group address is written in the configured style, the value as a canonical
  text (`valueText`).
- **The tunnel outlives a Gladys reconnection** and a configuration change
  that keeps the host, the port and the protocol: interfaces have few tunnels
  to give, so nothing reconnects without a reason. The Test button only asks
  for the description while our tunnel is up.
- **Built blind**: no KNX installation was available. Everything a tester
  must confirm is in `TODO.md`; the KNX-specific names live in `src/knx/` so
  a report fixes one place.
- **Read-only rootfs**: write nothing on disk.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag.
- **Changelog**: every user-visible change adds a line under
  `## [Unreleased]` in `CHANGELOG.md`.
- **Manifest texts** are `{ en, fr }` objects; the catalog description holds
  10 to 100 characters per language; `test/manifest.test.js` ties the
  manifest to the code (keys, defaults, DPT options, event keys, every
  grammar word in the field description).
- **User-facing text** is bilingual, `docs/en.md` and `docs/fr.md` kept in
  sync. Comments explain why, in English.
- **Tests never touch the network** (the socket factories throw; the fake
  gateway replaces them).

## Choices made where the spec left room

- **`devices` is a `string` field**: the manifest has no multi-line type, so
  devices are separated by new lines or commas (a pasted multi-line text may
  lose its line breaks in a one-line input; commas always work). A name
  cannot hold `;`, `,` or `=`.
- **Sensor DPTs**: one default per key and a short list after `@`, converted
  to one unit per feature (kW → W, Wh → kWh, mV → V, mA → A, Pa → hPa,
  km/h → m/s). The energy is an `energy-sensor` / `index` in kWh, so the
  Gladys energy monitoring can use it.
- **Shutters**: Gladys position 100 = open, KNX 0 % = open: inverted by
  default; `invert` keeps the KNX direction and swaps up/down. The position
  follows `position_state` only when there is one (the command address is a
  target, not a state).
- **HVAC mode ↔ Gladys preset**: auto ↔ schedule, comfort ↔ comfort, standby
  ↔ eco, economy ↔ night, building protection ↔ frost (away is sent as
  economy).
- **The event `value`** is a text (`1`, `21.5`, `comfort`, `+3`), `number` its
  numeric twin; an undeclared address gives a 1-bit value as `1`/`0` (a push
  button needs no declaration) and longer payloads as hex.
- **TCP is offered** (it was cheap): same frames with the TCP HPAI, no ACK,
  the stream cut by the header length.
- **A DESCRIPTION_REQUEST precedes every CONNECT** (2-3 s at most when
  unanswered) so the status names the gateway.
- **DPT 9**: 2047.5 rounds to the next exponent instead of wrapping to 0 as
  xknx does; every xknx vector still matches.
- **A "KNX bus" widget** (not asked): the last telegrams, to help testers
  find their addresses.
- **An `event_addresses` filter** and an `address_style` option, so a busy
  bus or a two-level project can use the trigger.

## CI and pushes

- Group the commits and push **at most once a day**, unless the maintainer
  explicitly asks otherwise: the GitHub Actions quota is limited.
- If every CI job fails in under 2 seconds, the quota is exhausted: it is
  not a bug in the code.
- The Docker image cannot be built in the Claude Code cloud container (no
  network for `apk` inside `docker build`): the CI builds it.

## Reading the reference implementation

The test vectors come from xknx (MIT), read only, never run:

```bash
mkdir -p /tmp/xknx && cd /tmp/xknx
curl -sO https://raw.githubusercontent.com/XKNX/xknx/main/test/knxip_tests/tunnelling_request_test.py
curl -sO https://raw.githubusercontent.com/XKNX/xknx/main/xknx/dpt/dpt_9.py
```

Copy expected bytes, never code: the licences differ and the codecs here are
written from the specification.
