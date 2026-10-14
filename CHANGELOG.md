# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- KNXnet/IP tunnelling to a KNX IP interface or router on the local network,
  over UDP (with the "route back" address, so it works behind Docker's NAT)
  or TCP (KNXnet/IP 2): connection heartbeat every 60 s, acknowledgements and
  repetition as the specification asks, automatic reconnection.
- A device list typed in the configuration, one device per line: lights,
  dimmers, shutters (with an `invert` flag), switches, sensors (temperature,
  humidity, illuminance, CO2, wind, pressure, power, energy, voltage, current,
  counter, with a choice of DPT), thermostats (setpoint, temperature, HVAC
  mode, heating) and binary sensors (contact, motion, presence, smoke, leak).
  Group addresses in three levels, two levels or free style; every mistake is
  reported with the number of its device.
- The status addresses of the created devices are read at each connection,
  paced, then the bus is followed: states change in Gladys as the
  installation moves.
- Commands from Gladys sent as group writes with the right DPT.
- Scene trigger "KNX group value received" (group address, device and value
  filters; decoded value, raw value, sender).
- Scene action "Send a KNX group value" with eleven DPT choices, raw octets
  included.
- Dashboard widget "KNX bus": the tunnel state and the last telegrams.
- "Test the gateway" button: the gateway's description and a short tunnel.
