// -----------------------------------------------------------------------------
// The integration itself: the devices declared in the configuration, the
// tunnel to the gateway, the states followed on the bus, the commands, the
// scene trigger and action, the bus monitor widget and the Test button.
// index.js only wires the SDK handlers to it.
//
// Pace: nothing is polled. At each connection the status addresses of the
// created devices are read once (one read every 250 ms), then the bus pushes
// every change. See src/knx/tunnel.js for the telegram pacing.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { MONITOR_SIZE, PACING, SEND_DPTS, WIDGETS } from './constants.js';
import { buildDevice, ids, parseExternalId } from './devices.js';
import { T, errorsSummary, reasonOf } from './i18n.js';
import { formatGroupAddress, formatIndividualAddress, parseGroupAddress } from './knx/address.js';
import {
  DptError,
  decode,
  encode,
  parseHex,
  parseValue,
  payloadHex,
  valueText,
} from './knx/dpt.js';
import { KnxTunnel, probeGateway } from './knx/tunnel.js';
import { createTransport } from './knx/transport.js';
import { commandsOf, isMeasurement, listenersOf, readAddresses, stateOf } from './model.js';
import { StatePublisher } from './publisher.js';
import { EventGate, groupValueEvent } from './triggers.js';
import { busWidget } from './widget.js';

const defaultTimers = { setTimeout, clearTimeout, setInterval, clearInterval };

/** What a tunnel depends on: the same values keep the tunnel open across a restart. */
const connectionKey = (config) => JSON.stringify([config.host, config.port, config.protocol]);

export class KnxApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'knx' }),
    now = Date.now,
    timers = defaultTimers,
    transportFactory = createTransport,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.transportFactory = transportFactory;
    this.config = normalizeConfig();
    this.listeners = new Map();
    this.definitions = new Map();
    this.tunnel = undefined;
    this.tunnelKey = undefined;
    this.tunnelError = undefined;
    this.publisher = new StatePublisher({ gladys, logger, timers, now });
    this.gate = new EventGate({ now });
    this.monitor = [];
    this.received = 0;
    this.widgetNudgedAt = 0;
    this.lastStatus = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * (Re)start with a configuration. When the gateway settings did not change
   * the tunnel stays open: editing the device list costs the gateway nothing.
   */
  async start(raw = {}) {
    const config = normalizeConfig(raw);
    const key = connectionKey(config);
    if (this.tunnel && key !== this.tunnelKey) {
      await this.stopTunnel();
    }
    this.config = config;
    this.definitions = new Map(config.definitions.map((d) => [d.id, d]));
    this.listeners = listenersOf(config.definitions);
    for (const error of config.errors) {
      this.logger.warn(`Device list: ${errorsSummary([error]).en}`);
    }
    try {
      await this.publishDevices();
    } catch (err) {
      this.logger.warn(`Publishing the devices failed: ${err.message}`);
    }
    if (!config.host) {
      await this.setStatus(false, T.join(T.noHost, this.configNotes()));
      return;
    }
    if (this.tunnel) {
      await this.refreshStatus();
      this.readAll();
      return;
    }
    this.tunnelKey = key;
    this.tunnelError = undefined;
    // The callbacks of a tunnel already replaced are ignored.
    const tunnel = new KnxTunnel({
      host: config.host,
      port: config.port,
      protocol: config.protocol,
      logger: this.logger,
      timers: this.timers,
      now: this.now,
      transportFactory: this.transportFactory,
      onTelegram: (telegram) => this.tunnel === tunnel && this.onTelegram(telegram),
      onStatus: (status) => this.tunnel === tunnel && this.onTunnelStatus(status),
    });
    this.tunnel = tunnel;
    await this.setStatus(false, T.connecting(config.host));
    tunnel.start();
  }

  async stop() {
    this.publisher.stop();
    await this.stopTunnel();
  }

  async stopTunnel() {
    const tunnel = this.tunnel;
    this.tunnel = undefined;
    this.tunnelKey = undefined;
    if (tunnel) {
      await tunnel.stop();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** The mistakes of the configuration, appended to every status. */
  configNotes() {
    const notes = [];
    if (this.config.errors.length > 0) {
      notes.push(errorsSummary(this.config.errors));
    }
    if (this.config.invalidEventAddresses.length > 0) {
      notes.push(T.invalidEventAddresses(this.config.invalidEventAddresses));
    }
    return T.join(...notes);
  }

  gatewayName() {
    return T.gateway(this.tunnel?.description, this.config.host);
  }

  async refreshStatus() {
    const tunnel = this.tunnel;
    if (!tunnel) {
      return;
    }
    if (!tunnel.connected) {
      const reason = this.tunnelError
        ? T.unreachable(this.config.host, reasonOf(this.tunnelError.error), this.tunnelError.retry)
        : T.connecting(this.config.host);
      await this.setStatus(false, T.join(reason, this.configNotes()));
      return;
    }
    const declared = this.config.definitions.length;
    const main =
      declared === 0
        ? T.noDevice
        : T.ok({
            gateway: this.gatewayName(),
            address: formatIndividualAddress(tunnel.address ?? 0),
            declared,
            created: this.createdDefinitions().length,
          });
    await this.setStatus(true, T.join(main, this.configNotes()));
  }

  async onTunnelStatus(status) {
    if (status.connected) {
      this.tunnelError = undefined;
      this.logger.info(
        `KNX tunnel open to ${this.config.host} as ${formatIndividualAddress(this.tunnel?.address ?? 0)}`,
      );
      await this.refreshStatus();
      this.readAll();
    } else {
      this.tunnelError = { error: status.error, retry: status.retryInMs };
      await this.refreshStatus();
    }
    this.nudgeWidget(true);
  }

  // --- Devices ---------------------------------------------------------------------

  async publishDevices() {
    await this.gladys.publishDiscoveredDevices(
      this.config.definitions.map((d) => buildDevice(this.gladys, d, this.config.addressStyle)),
    );
  }

  /** The definitions of the devices the user created. */
  createdDefinitions() {
    const created = [];
    for (const device of this.gladys.devices ?? []) {
      const definition = this.definitions.get(parseExternalId(device.external_id)?.id);
      if (definition) {
        created.push(definition);
      }
    }
    return created;
  }

  /** Read the status addresses of the created devices (the reads are paced by the tunnel). */
  readAll(definitions = this.createdDefinitions()) {
    if (!this.tunnel?.connected) {
      return;
    }
    const addresses = new Set(definitions.flatMap(readAddresses));
    for (const ga of addresses) {
      this.tunnel.read(ga).catch((err) => this.logger.debug?.(`Read failed: ${err.message}`));
    }
  }

  /** A device was just created: read its status now rather than at the next connection. */
  async deviceCreated(device) {
    const definition = this.definitions.get(parseExternalId(device.external_id)?.id);
    if (definition) {
      this.readAll([definition]);
      await this.refreshStatus();
    }
  }

  // --- The bus ------------------------------------------------------------------------

  /** A group telegram from the bus (or our own write, `echo`): states, event, monitor. */
  onTelegram(telegram, { echo = false } = {}) {
    if (!echo) {
      this.received += 1;
    }
    const style = this.config.addressStyle;
    const listeners = this.listeners.get(telegram.ga) ?? [];
    const created = new Set(this.createdDefinitions().map((d) => d.id));
    let shown;
    let deviceName;
    for (const { definition, key } of listeners) {
      if (telegram.service === 'read') {
        deviceName = deviceName ?? definition.name;
        continue;
      }
      const dpt = definition.addresses[key].dpt;
      let value;
      try {
        value = decode(dpt, telegram.payload);
      } catch (err) {
        this.logger.debug?.(`${definition.name} ${key}: ${err.message}`);
        continue;
      }
      if (shown === undefined) {
        shown = valueText(dpt, value);
        deviceName = definition.name;
      }
      const state = stateOf(definition, key, value);
      if (state && state.value !== undefined && created.has(definition.id)) {
        const id = ids.feature(ids.device(this.gladys, definition), state.feature);
        this.publisher.push(id, state.value, {
          measurement: isMeasurement(definition, state.feature),
        });
      }
    }
    if (!echo) {
      const event = groupValueEvent(telegram, {
        listeners: this.listeners,
        deviceIdOf: (definition) => ids.device(this.gladys, definition),
        style,
        eventAddresses: this.config.eventAddresses,
      });
      if (event && this.gate.admit(event)) {
        this.gladys
          .publishSceneEvent(event.key, event.data)
          .catch((err) => this.logger.warn(`Scene event failed: ${err.message}`));
      }
    }
    this.monitor.unshift({
      at: new Date(this.now()).toISOString(),
      groupAddress: formatGroupAddress(telegram.ga, style),
      deviceName,
      value:
        telegram.service === 'read'
          ? '?'
          : (shown ??
            (telegram.payload.small
              ? String(telegram.payload.value)
              : `0x${payloadHex(telegram.payload)}`)),
      service: telegram.service,
      source: formatIndividualAddress(telegram.source),
    });
    this.monitor.length = Math.min(this.monitor.length, MONITOR_SIZE);
    this.nudgeWidget();
  }

  nudgeWidget(force = false) {
    if (force || this.now() - this.widgetNudgedAt >= PACING.WIDGET_REFRESH) {
      this.widgetNudgedAt = this.now();
      this.gladys.requestWidgetRefresh(WIDGETS.BUS);
    }
  }

  /** Send a group write and show it as if it came back from the bus. */
  async writeGroup(ga, payload) {
    if (!this.tunnel?.connected) {
      throw new Error(T.notConnected.en);
    }
    await this.tunnel.write(ga, payload);
    this.onTelegram(
      { service: 'write', ga, payload, source: this.tunnel?.address ?? 0 },
      { echo: true },
    );
  }

  // --- Commands --------------------------------------------------------------------------

  async setValue(device, feature, value) {
    const definition = this.definitions.get(parseExternalId(device.external_id)?.id);
    if (!definition) {
      throw new Error(`${device.name ?? device.external_id} is no longer in the KNX device list`);
    }
    const key = String(feature.external_id).split(':').at(-1);
    for (const command of commandsOf(definition, key, value)) {
      await this.writeGroup(command.ga, encode(command.dpt, command.value));
    }
  }

  // --- Scene action -------------------------------------------------------------------------

  async sendGroupValue(fields = {}) {
    const address = parseGroupAddress(fields.group_address);
    if (address.error) {
      throw new Error(`"${fields.group_address ?? ''}" is not a group address`);
    }
    const dpt = String(fields.dpt ?? '');
    if (!SEND_DPTS.includes(dpt)) {
      throw new Error(`Unknown DPT "${dpt}"`);
    }
    let payload;
    try {
      payload = dpt === 'raw' ? parseHex(fields.value) : encode(dpt, parseValue(dpt, fields.value));
    } catch (err) {
      throw err instanceof DptError ? new Error(err.message) : err;
    }
    await this.writeGroup(address.raw, payload);
    return {
      group_address: formatGroupAddress(address.raw, this.config.addressStyle),
      raw: payloadHex(payload),
    };
  }

  // --- Widget ----------------------------------------------------------------------------------

  async getWidget(_key, { language } = {}) {
    const tunnel = this.tunnel;
    return busWidget({
      connected: Boolean(tunnel?.connected),
      gatewayName: tunnel?.description?.name,
      address: tunnel?.address !== undefined ? formatIndividualAddress(tunnel.address) : undefined,
      received: this.received,
      declared: this.config.definitions.length,
      created: this.createdDefinitions().length,
      telegrams: this.monitor,
      language,
    });
  }

  // --- Test button ------------------------------------------------------------------------------

  async testGateway() {
    const { host, port, protocol } = this.config;
    if (!host) {
      return T.noHost;
    }
    const options = {
      host,
      port,
      protocol,
      logger: this.logger,
      timers: this.timers,
      now: this.now,
      transportFactory: this.transportFactory,
    };
    try {
      const tunnel = this.tunnel;
      if (tunnel?.connected) {
        // An interface often has one tunnel to give: ask for the description only.
        const { description } = await probeGateway(options, { connect: false }).catch(() => ({}));
        return T.join(
          description ? T.test.described(T.gateway(description, host)) : T.test.noDescription,
          T.test.running(
            formatIndividualAddress(tunnel.address ?? 0),
            tunnel.counters.received,
            tunnel.counters.sent,
          ),
        );
      }
      const result = await probeGateway(options, { connect: true });
      return T.join(
        result.description
          ? T.test.described(T.gateway(result.description, host))
          : T.test.noDescription,
        T.test.tunnel(formatIndividualAddress(result.address ?? 0)),
      );
    } catch (err) {
      return T.join(
        T.test.failed(host, reasonOf(err)),
        protocol === 'tcp' ? T.test.tcpHint : undefined,
      );
    }
  }
}
