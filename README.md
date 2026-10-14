# gladys-knx

[Gladys Assistant](https://gladysassistant.com) external integration for
**KNX** over **KNXnet/IP tunnelling** (UDP or TCP): lights, dimmers, shutters,
switches, sensors and thermostats by group address, on your local network,
with a scene trigger on group telegrams, a scene action to send any group
value and a bus monitor widget. **Unofficial, not affiliated with the KNX
Association.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/app.js (KnxApp)
                 ├─ src/config.js        the `devices` grammar (pure)
                 ├─ src/devices.js       types, keys, DPTs -> Gladys devices (pure)
                 ├─ src/model.js         bus value <-> Gladys state, commands (pure)
                 ├─ src/triggers.js      GroupValue_Write -> scene event (pure)
                 ├─ src/widget.js        the bus monitor (pure)
                 └─ src/knx/tunnel.js    KNXnet/IP tunnel client
                      ├─ frames.js, cemi.js, dpt.js, address.js   (pure)
                      └─ transport.js    dgram / net, the only network access
```

- **Devices** come from the `devices` field of the configuration, one per
  line: `light; Living room; switch=1/1/1; state=1/1/2`. KNX has no discovery;
  the integration publishes the list in Discovery, each device identified by
  its type and name.
- **Tunnel**: CONNECT_REQUEST with the route-back HPAI (the container is
  behind Docker's NAT, so multicast routing is out of reach), heartbeat every
  60 s, TUNNELLING_ACK within 1 s and one repeat, L_Data.con before the next
  telegram, automatic reconnection.
- **States**: the status addresses of the created devices are read once per
  connection (one read every 250 ms), then every L_Data.ind updates them.
- **Events**: each GroupValue_Write of the bus fires `group_value_received`,
  decoded when the address belongs to a declared device.

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npx github:GladysAssistant/integration-store .  # store admission checks
```

The protocol is checked byte for byte: the expected frames and DPT values of
the tests come from the xknx test suite (some captured on real
installations), and the fake gateway of `test/helpers/` is written by hand
from the KNX specification. No real gateway was available: see `TODO.md`.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0.
