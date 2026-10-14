# KNX

**Unofficial connector, not affiliated with the KNX Association.** It connects
Gladys to a KNX installation through a KNXnet/IP interface or router on your
local network: lights, dimmers, shutters, switches, sensors and thermostats,
by group address. No cloud, no ETS needed. KNX is a trademark of the KNX
Association.

## What you need

- A **KNXnet/IP interface or router** (an "IP interface" or "IP router" in your
  KNX cabinet) reachable from the Gladys machine, with a free **tunnelling
  connection**. An interface usually offers 1 to 8 of them; ETS and every other
  software connected at the same time use one each, this integration one.
- The **group addresses** of what you want to control and read: they come from
  your ETS project (or from your installer).

Why tunnelling and not routing: the integration runs in its own container
behind Docker's NAT, where the KNX multicast (224.0.23.12) never arrives. A
KNX IP router is used in tunnelling mode, like an interface.

## Setup

1. Give the gateway a fixed IP address (a DHCP reservation in your router).
2. Install the integration and type the **gateway address**. Keep the port
   3671 and **UDP** unless you know better: **TCP** only works with KNXnet/IP 2
   gateways ("tunnelling v2"), and needs no acknowledgement per telegram.
3. Press **Test the gateway**: it shows the name of the gateway and opens then
   closes a tunnel.
4. List your **devices** (below), save, then open **Discovery** and add them.
5. Optional: put the **KNX bus** widget on a dashboard. It shows the last
   telegrams of the bus: operate a wall switch and its group address appears,
   a quick way to fill the list.

## The device list

One device per line (or separated by commas), fields separated by semicolons:

```
type; name; key=group address; key=group address; ...; flag
```

Examples:

```
light; Living room; switch=1/1/1; state=1/1/2
dimmer; Kitchen; switch=1/2/1; state=1/2/2; brightness=1/2/3; brightness_state=1/2/4
shutter; Bedroom; move=2/1/1; stop=2/1/2; position=2/1/3; position_state=2/1/4
switch; Pump; switch=3/1/1
sensor; Office; temperature=4/1/1; humidity=4/1/2
sensor; Meter; power=4/2/1@9.024; energy=4/2/2@13.013
thermostat; Office; setpoint=5/1/1; setpoint_state=5/1/2; temperature=5/1/3; mode=5/1/4; mode_state=5/1/5
binary; Window; contact=6/1/1
# a line starting with # is a comment
```

| Type         | Keys (DPT)                                                                                                                                                                                                                                                                                      | Flags    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `light`      | `switch` (1.001, required), `state` (1.001)                                                                                                                                                                                                                                                     |          |
| `dimmer`     | `switch`, `state` (1.001), `brightness`, `brightness_state` (5.001); `switch` or `brightness` required                                                                                                                                                                                          |          |
| `shutter`    | `move` (1.008 up/down), `stop` (1.017), `position`, `position_state` (5.001); `move` or `position` required                                                                                                                                                                                     | `invert` |
| `switch`     | `switch` (1.001, required), `state` (1.001)                                                                                                                                                                                                                                                     |          |
| `sensor`     | `temperature` (9.001, 14.068), `humidity` (9.007, 5.001), `illuminance` or `lux` (9.004), `co2` (9.008), `wind` (9.005, 9.028), `pressure` (9.006, 14.058), `power` (14.056, 9.024), `energy` (13.010, 13.013), `voltage` (14.027, 9.020), `current` (14.019, 9.021), `counter` (5.010, 13.001) |          |
| `thermostat` | `setpoint`, `setpoint_state` (9.001), `temperature` (9.001), `mode`, `mode_state` (20.102), `heating` (1.001)                                                                                                                                                                                   |          |
| `binary`     | `contact` (1.019), `motion`, `presence`, `smoke`, `leak` (1.x)                                                                                                                                                                                                                                  | `invert` |

- **Group addresses** in three levels (`1/2/3`), two levels (`1/515`) or free
  style (`2563`): the three mean the same address.
- **Command and status addresses**: `switch`, `brightness`, `position`,
  `setpoint` and `mode` are written by Gladys; `state`, `brightness_state`,
  `position_state`, `setpoint_state`, `mode_state` and the sensors are read
  when the integration connects and followed afterwards. Give the status
  addresses when your actuators have them: Gladys then shows the real state.
- **Another DPT** for a sensor after `@`: `power=4/2/1@9.024` for a power in kW
  on two octets. Gladys always receives W, kWh (the energy is a meter index,
  ready for the energy monitoring), V, A, hPa, m/s, lux, ppm, °C and %.
- `invert` on a **shutter** swaps up and down and the position direction, for
  actuators set up the other way; on a **binary** sensor it inverts the value
  (a contact that sends 1 when closed).
- A mistake (unknown type or key, wrong address, missing address, the same
  name twice for one type) is shown in the status of the integration with the
  number of the device; the other devices keep working.

### Renaming a device

The identifier of a device comes from its **type and name**, not from its
position: reorder the list freely, and change its addresses freely. Renaming
a device (or changing its type) makes a new one in Discovery: add it, then
delete the old one, whose scenes must be updated.

## What Gladys shows

- **Shutters**: Gladys counts 100 % as open; KNX counts 0 % as open (up). The
  integration converts both ways; `invert` keeps the KNX direction.
- **Contacts** (DPT 1.019, 1 = open) become opening sensors.
- **Thermostat modes** (DPT 20.102): auto ↔ schedule, comfort ↔ comfort,
  standby ↔ eco, economy ↔ night, building protection ↔ frost.
- A measurement (temperature, power…) reaches Gladys at most every 30 seconds
  per sensor, the latest value winning: an energy meter sending every second
  does not flood Gladys.

## Scenes

**KNX group value received** starts a scene when a device of the bus writes to
a group address: a push button, a central command, a sensor sending its
value. Leave the fields empty to accept everything, or fill:

- **Group address**: written as in the "Group address style" option (three
  levels by default, `7/1/1`);
- **Device**: one of the devices of the list;
- **Value**: `1` or `0` for a switch or a push button, `21.5` for a
  temperature, `comfort` for an HVAC mode, `+3` for a dimming step. An address
  missing from the list gives the 1-bit values as `1` / `0` and the others as
  hexadecimal octets (`0c1a`).

The variables: the group address, the device, the value as text and as a
number, the raw octets, the DPT and the sender (individual address). The
answers to reads do not start scenes, nor the telegrams the integration sends
itself. At most 120 events a minute, and the same telegram repeated by the bus
within a second counts once.

**Send a KNX group value** writes a value to a group address with the chosen
DPT: `1` (on/off, up/down: `1`, `0`, `on`, `off`, `up`, `down`), `3.007`
(`+1` to `+7`, `-1` to `-7`, `stop`), `5.001` (0-100), `5.010` (0-255), `9`
(a decimal), `13` (an integer), `14` (a decimal), `17.001` (scene 1-64),
`18.001` (`5`, or `learn 5`), `20.102` (`auto`, `comfort`, `standby`,
`economy`, `building_protection`) or `raw` (octets in hexadecimal: `0C 1A`).

## Gentle with the bus

One telegram at a time, each one acknowledged by the gateway and confirmed on
the bus before the next, 100 ms after a write and 250 ms after a read. The
status addresses are read once at each connection, never polled: the bus
pushes every change. The tunnel is checked every 60 seconds and rebuilt after
three missed answers; the reconnection waits 2 seconds, then longer, up to a
minute.

## Troubleshooting

- **No answer**: check the address and the port, and that the Gladys machine
  reaches the gateway (same network, no VLAN or firewall between them).
- **Every tunnelling connection of the gateway is in use**: close ETS or the
  other software, or free a tunnel in the interface's settings; the
  integration tries again every minute.
- **A state never shows**: the status address must have its "read" flag in ETS
  to answer the reads, and its "transmit" flag to send its changes.
- **A strange value**: the DPT of the address is not the expected one; choose
  another one after `@` (sensors) or check the address in ETS.
- **TCP fails, UDP works**: the gateway is KNXnet/IP 1 only; keep UDP.
- Logs: the integration's log level is set with the `LOG_LEVEL` variable.

## Security and privacy

Everything stays on your network: the integration talks to the gateway and
to Gladys, nothing else. A plain KNXnet/IP tunnel is not encrypted; KNX IP
Secure is not supported yet. Any software on your network that reaches the
gateway can do the same, which is how KNX works: keep the gateway on a
trusted network.
