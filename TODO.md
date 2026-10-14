# TODO

## Before announcing

- [ ] Test on a real Gladys 5.1+ with a real KNX installation: a KNX IP
      interface (UDP), a KNX IP router used as a tunnel server, and a
      KNXnet/IP 2 device over TCP (MDT, Weinzierl, Gira or ABB, whatever the
      testers of the forum have).
- [ ] Run the integration for a day: the heartbeat keeps the Docker NAT
      mapping of the UDP socket alive, no reconnection loop in the logs.
- [ ] Every device type with real actuators: a light with and without status
      address, a dimmer, a shutter with `stop` and `position_state`, a
      thermostat (setpoint, HVAC mode), a window contact, a meter.
- [ ] Reserve "KNX" in the forum thread of the integrations (testers wanted:
      no hardware here), then add the `gladys-assistant-integration` topic to
      publish in the store.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).

## To confirm (built blind: no gateway, no Gladys installation)

- [ ] A real gateway answers the route-back HPAI (0.0.0.0:0) from behind the
      Docker bridge, and sends its TUNNELLING_REQUESTs to the NATed port.
- [ ] The data endpoint of the CONNECT_RESPONSE: some gateways announce
      another port (or 0.0.0.0); the ACKs and our telegrams go there.
- [ ] Every gateway sends an L_Data.con for each telegram (the client waits
      up to 3 s for it, then counts the telegram as sent).
- [ ] The source address: the integration puts the tunnel's individual
      address (from the CRD) in its L_Data.req, as xknx does.
- [ ] TCP: the framing and the absence of TUNNELLING_ACK on a real
      KNXnet/IP 2 device; whether the DESCRIPTION_REQUEST is answered on the
      same TCP connection.
- [ ] Gladys: shutter position 100 = open (the integration inverts the KNX
      position by default), the `shutter` / `state` command values (1 open,
      -1 close, 0 stop), the thermostat `preset` feature with
      `supported_options`, `has_feedback` with a status address.
- [ ] Gladys: the `energy-sensor` / `index` feature in kWh feeds the energy
      monitoring.
- [ ] Gladys: whether the one-line `string` input keeps the line breaks of a
      pasted list (the grammar accepts commas in any case).
- [ ] Gladys: the scene editor matches the `value` field (a string) of the
      trigger as expected for `1`, `21.5`, `comfort`.
- [ ] The default DPTs of the sensors match what installers usually program
      (humidity often 9.007, sometimes 5.001; power 14.056 or 9.024).

## Ideas

- KNX IP Secure tunnelling (a device password and a user password in the
  configuration, the secure session of 03.08.09).
- Import the group addresses exported by ETS (CSV paste in the
  configuration) to suggest the devices.
- A "read a group value" scene action (GroupValue_Read, wait for the
  response) for a condition on an address that is not a device.
- More device types: RGB lights (DPT 232.600), fans, scenes as buttons
  (DPT 17.001), HVAC controller mode (20.105), wind alarm, rain.
- An individual address requested for the tunnel (extended CRI, KNXnet/IP 2).
- A cyclic read option for status addresses whose actuator never transmits.
