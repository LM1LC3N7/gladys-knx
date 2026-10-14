// -----------------------------------------------------------------------------
// The KNXnet/IP tunnel client (KNX 03.08.02 Core, 03.08.04 Tunnelling): one
// tunnel to the gateway, kept alive for life until stop().
//
//   connect     DESCRIPTION (the gateway's name, optional) then CONNECT_REQUEST
//               with a basic tunnel CRI (link layer) and the route-back HPAI
//   heartbeat   CONNECTIONSTATE_REQUEST every 60 s, 10 s to answer; three
//               failures in a row and the tunnel is rebuilt
//   send        one telegram at a time: TUNNELLING_REQUEST with our sequence
//               counter, TUNNELLING_ACK within 1 s (UDP), one repeat with the
//               same counter, then the tunnel is rebuilt; then the
//               L_Data.con (3 s at most) before the next telegram, and a pause
//               of 100 ms after a write, 250 ms after a read
//   receive     every TUNNELLING_REQUEST of our channel is acknowledged (UDP);
//               a repeated counter is acknowledged and dropped; an unexpected
//               one is dropped, and the tunnel rebuilt when the expected one
//               does not follow within 2 s
//   stop        DISCONNECT_REQUEST, 1 s for the answer
//
// Over TCP (KNXnet/IP 2) the stream is reliable: no TUNNELLING_ACK either way.
// -----------------------------------------------------------------------------

import { PACING, TIMING } from '../constants.js';
import { SERVICES, groupRequest, parseCemi } from './cemi.js';
import {
  HOST_PROTOCOL,
  SERVICE,
  STATUS,
  connectRequest,
  connectionStateRequest,
  descriptionRequest,
  disconnectRequest,
  disconnectResponse,
  statusName,
  tunnellingAck,
  tunnellingRequest,
} from './frames.js';
import { createTransport } from './transport.js';

/**
 * Codes: timeout (no answer), refused (CONNECT_RESPONSE error), busy (every
 * tunnel of the gateway taken), network (socket), lost (heartbeat), ack (a
 * frame not acknowledged), bus (negative L_Data.con), closed (the gateway
 * ended the tunnel), not_connected, queue_full, stopped.
 */
export class KnxError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'KnxError';
    this.code = code;
  }
}

const defaultTimers = { setTimeout, clearTimeout, setInterval, clearInterval };

export class KnxTunnel {
  constructor({
    host,
    port,
    protocol = 'udp',
    logger = console,
    timers = defaultTimers,
    now = Date.now,
    onTelegram = () => {},
    onStatus = () => {},
    transportFactory = createTransport,
  }) {
    this.host = host;
    this.port = port;
    this.protocol = protocol;
    this.hostProtocol = protocol === 'tcp' ? HOST_PROTOCOL.TCP : HOST_PROTOCOL.UDP;
    this.logger = logger;
    this.timers = timers;
    this.now = now;
    this.onTelegram = onTelegram;
    this.onStatus = onStatus;
    this.transportFactory = transportFactory;
    this.state = 'stopped';
    this.transport = undefined;
    this.channel = undefined;
    this.address = undefined;
    this.dataEndpoint = undefined;
    this.description = undefined;
    this.outSequence = 0;
    this.inSequence = 0;
    this.waiters = new Set();
    this.confirmWaiter = undefined;
    this.queue = [];
    this.inFlight = undefined;
    this.pumping = false;
    this.heartbeatTimer = undefined;
    this.retryTimer = undefined;
    this.sequenceTimer = undefined;
    this.retries = 0;
    this.beating = false;
    this.connectedAt = undefined;
    this.counters = { received: 0, sent: 0 };
  }

  get connected() {
    return this.state === 'connected';
  }

  sleep(ms) {
    return new Promise((resolve) => this.timers.setTimeout(resolve, ms));
  }

  // --- Lifecycle -----------------------------------------------------------------

  /** Connect now, and again after every loss, until stop(). */
  start() {
    if (this.state !== 'stopped') {
      return;
    }
    this.state = 'waiting';
    this.retries = 0;
    this.attempt();
  }

  attempt() {
    this.retryTimer = undefined;
    this.connect().catch((err) => this.scheduleRetry(err));
  }

  scheduleRetry(err) {
    if (this.state === 'stopped') {
      return;
    }
    const delay =
      err?.code === 'busy'
        ? PACING.RECONNECT_BUSY
        : Math.min(PACING.RECONNECT_MAX, PACING.RECONNECT_BASE * 2 ** this.retries);
    this.retries += 1;
    this.state = 'waiting';
    this.logger.warn(`KNX gateway ${this.host}: ${err.message}; next attempt in ${delay / 1000} s`);
    this.onStatus({ connected: false, error: err, retryInMs: delay });
    this.retryTimer = this.timers.setTimeout(() => this.attempt(), delay);
  }

  /** One connection attempt: resolves once the tunnel is up, rejects with a KnxError. */
  async connect() {
    this.state = 'connecting';
    this.closeTransport();
    const transport = this.transportFactory({
      host: this.host,
      port: this.port,
      protocol: this.protocol,
      logger: this.logger,
      onFrame: (frame) => {
        if (this.transport === transport) {
          this.handleFrame(frame);
        }
      },
      onClose: () => {
        if (this.transport === transport) {
          this.lost(new KnxError('closed', 'the gateway closed the connection'));
        }
      },
    });
    this.transport = transport;
    try {
      await this.withTimeout(transport.open(), TIMING.CONNECT_TIMEOUT);
    } catch (err) {
      this.closeTransport();
      throw err instanceof KnxError ? err : new KnxError('network', err.message);
    }
    if (this.transport !== transport) {
      throw new KnxError('stopped');
    }
    try {
      this.description = await this.describe();
    } catch {
      // Optional: the name of the gateway in the status, nothing more.
    }
    if (this.transport !== transport) {
      throw new KnxError('stopped');
    }
    let response;
    try {
      response = await this.request(
        connectRequest(this.hostProtocol),
        SERVICE.CONNECT_RESPONSE,
        TIMING.CONNECT_TIMEOUT,
      );
    } catch (err) {
      this.closeTransport();
      throw err;
    }
    if (response.status !== STATUS.NO_ERROR) {
      this.closeTransport();
      const busy = [STATUS.NO_MORE_CONNECTIONS, STATUS.NO_MORE_UNIQUE_CONNECTIONS].includes(
        response.status,
      );
      throw new KnxError(
        busy ? 'busy' : 'refused',
        `connection refused: ${statusName(response.status)}`,
      );
    }
    if (this.transport !== transport) {
      throw new KnxError('stopped');
    }
    this.channel = response.channel;
    this.address = response.address;
    const endpoint = response.dataEndpoint;
    this.dataEndpoint =
      this.protocol === 'udp' && endpoint && endpoint.ip !== '0.0.0.0' && endpoint.port !== 0
        ? { host: endpoint.ip, port: endpoint.port }
        : undefined;
    this.outSequence = 0;
    this.inSequence = 0;
    this.retries = 0;
    this.state = 'connected';
    this.connectedAt = this.now();
    this.heartbeatTimer = this.timers.setInterval(
      () => this.heartbeat(),
      TIMING.HEARTBEAT_INTERVAL,
    );
    this.onStatus({ connected: true });
    this.pump();
  }

  /** End the tunnel politely (DISCONNECT_REQUEST) and stop reconnecting. */
  async stop() {
    const wasConnected = this.state === 'connected' && this.channel !== undefined;
    this.state = 'stopped';
    this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.clearConnectionTimers();
    this.flushQueue(new KnxError('stopped', 'the integration stopped'));
    if (wasConnected && this.transport) {
      const channel = this.channel;
      await this.request(
        disconnectRequest(channel, this.hostProtocol),
        SERVICE.DISCONNECT_RESPONSE,
        TIMING.DISCONNECT_TIMEOUT,
        (frame) => frame.channel === channel,
      ).catch(() => {});
    }
    this.channel = undefined;
    this.closeTransport();
  }

  /** The tunnel broke: tell the gateway when we still can, then reconnect. */
  lost(err) {
    if (this.state === 'connecting') {
      // connect() fails with this error and schedules the next attempt.
      this.clearConnectionTimers(err);
      this.closeTransport();
      return;
    }
    if (this.state !== 'connected') {
      return;
    }
    this.logger.warn(`KNX tunnel lost: ${err.message}`);
    if (this.state === 'connected' && this.channel !== undefined && err.code !== 'closed') {
      this.send(disconnectRequest(this.channel, this.hostProtocol));
    }
    this.channel = undefined;
    this.clearConnectionTimers();
    this.flushQueue(new KnxError('not_connected', `the KNX tunnel was lost (${err.message})`));
    this.closeTransport();
    this.scheduleRetry(err);
  }

  clearConnectionTimers(err = new KnxError('not_connected', 'the KNX tunnel is down')) {
    this.timers.clearInterval(this.heartbeatTimer);
    this.timers.clearTimeout(this.sequenceTimer);
    this.heartbeatTimer = undefined;
    this.sequenceTimer = undefined;
    for (const waiter of this.waiters) {
      this.timers.clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.waiters.clear();
    if (this.confirmWaiter) {
      this.timers.clearTimeout(this.confirmWaiter.timer);
      this.confirmWaiter.resolve(undefined);
      this.confirmWaiter = undefined;
    }
  }

  closeTransport() {
    const transport = this.transport;
    this.transport = undefined;
    transport?.close();
  }

  // --- Frames ----------------------------------------------------------------------------

  send(buffer, endpoint) {
    this.transport?.send(buffer, endpoint);
  }

  /** Send a frame and wait for the answer of `service` that matches. */
  request(buffer, service, timeout, predicate = () => true, endpoint) {
    const promise = new Promise((resolve, reject) => {
      const waiter = { service, predicate, resolve, reject };
      waiter.timer = this.timers.setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new KnxError('timeout', `no answer from the gateway within ${timeout / 1000} s`));
      }, timeout);
      this.waiters.add(waiter);
    });
    this.send(buffer, endpoint);
    return promise;
  }

  withTimeout(promise, timeout) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = this.timers.setTimeout(
          () => reject(new KnxError('timeout', `no answer within ${timeout / 1000} s`)),
          timeout,
        );
      }),
    ]).finally(() => this.timers.clearTimeout(timer));
  }

  handleFrame(frame) {
    for (const waiter of this.waiters) {
      if (waiter.service === frame.service && waiter.predicate(frame)) {
        this.waiters.delete(waiter);
        this.timers.clearTimeout(waiter.timer);
        waiter.resolve(frame);
        return;
      }
    }
    if (frame.service === SERVICE.TUNNELLING_REQUEST) {
      this.receiveTunnelling(frame);
    } else if (frame.service === SERVICE.DISCONNECT_REQUEST) {
      if (this.channel !== undefined && frame.channel === this.channel) {
        this.send(disconnectResponse(frame.channel));
        this.lost(new KnxError('closed', 'the gateway ended the tunnel'));
      }
    }
  }

  receiveTunnelling(frame) {
    if (this.state !== 'connected' || frame.channel !== this.channel) {
      return;
    }
    if (this.protocol === 'udp') {
      const expected = this.inSequence;
      if (frame.sequence === expected) {
        this.inSequence = (expected + 1) & 0xff;
        this.timers.clearTimeout(this.sequenceTimer);
        this.sequenceTimer = undefined;
        this.send(tunnellingAck(frame.channel, frame.sequence), this.dataEndpoint);
      } else if (frame.sequence === ((expected - 1) & 0xff)) {
        // Our ACK got lost: acknowledge again, the frame was already handled.
        this.send(tunnellingAck(frame.channel, frame.sequence), this.dataEndpoint);
        return;
      } else {
        // Dropped without an ACK: the gateway repeats it; when the expected
        // one never comes, both sides are out of step: rebuild the tunnel.
        this.logger.debug?.(`KNX: sequence ${frame.sequence} while ${expected} was expected`);
        if (!this.sequenceTimer) {
          this.sequenceTimer = this.timers.setTimeout(() => {
            this.sequenceTimer = undefined;
            this.lost(new KnxError('lost', 'the sequence counters went out of step'));
          }, TIMING.SEQUENCE_GRACE);
        }
        return;
      }
    }
    const telegram = parseCemi(frame.cemi);
    if (!telegram) {
      return;
    }
    if (telegram.code === 'con') {
      const waiter = this.confirmWaiter;
      if (waiter && waiter.ga === telegram.ga && waiter.service === telegram.service) {
        this.confirmWaiter = undefined;
        this.timers.clearTimeout(waiter.timer);
        waiter.resolve(telegram);
      }
      return;
    }
    this.counters.received += 1;
    try {
      this.onTelegram(telegram);
    } catch (err) {
      this.logger.warn(`KNX telegram handling failed: ${err.message}`);
    }
  }

  async heartbeat() {
    if (this.state !== 'connected' || this.beating) {
      return;
    }
    this.beating = true;
    const channel = this.channel;
    let reason = 'no answer';
    try {
      for (let i = 0; i < TIMING.HEARTBEAT_FAILURES; i += 1) {
        if (this.state !== 'connected' || this.channel !== channel) {
          return;
        }
        try {
          const answer = await this.request(
            connectionStateRequest(channel, this.hostProtocol),
            SERVICE.CONNECTIONSTATE_RESPONSE,
            TIMING.CONNECTIONSTATE_TIMEOUT,
            (frame) => frame.channel === channel,
          );
          if (answer.status === STATUS.NO_ERROR) {
            return;
          }
          reason = statusName(answer.status);
        } catch (err) {
          if (err.code !== 'timeout') {
            return; // the tunnel went down meanwhile
          }
          reason = 'no answer';
        }
      }
      this.lost(new KnxError('lost', `heartbeat failed 3 times (${reason})`));
    } finally {
      this.beating = false;
    }
  }

  /** DESCRIPTION_REQUEST on the open transport -> the parsed DIBs. */
  describe() {
    return this.request(
      descriptionRequest(this.hostProtocol),
      SERVICE.DESCRIPTION_RESPONSE,
      TIMING.DESCRIPTION_TIMEOUT,
    );
  }

  // --- Group telegrams ------------------------------------------------------------------

  /** GroupValue_Write; resolves once the gateway confirmed it on the bus. */
  write(ga, payload) {
    return this.enqueue({ service: SERVICES.WRITE, ga, payload });
  }

  /**
   * GroupValue_Read; the answer arrives as a telegram. A read of an address
   * already waiting or on its way is not queued twice.
   */
  read(ga) {
    const same = (item) => item?.service === SERVICES.READ && item.ga === ga;
    if (same(this.inFlight) || this.queue.some(same)) {
      return Promise.resolve();
    }
    return this.enqueue({ service: SERVICES.READ, ga });
  }

  enqueue(item) {
    if (this.state !== 'connected') {
      return Promise.reject(new KnxError('not_connected', 'the KNX tunnel is not connected'));
    }
    if (this.queue.length >= PACING.QUEUE_LIMIT) {
      return Promise.reject(new KnxError('queue_full', 'too many telegrams waiting'));
    }
    const promise = new Promise((resolve, reject) => {
      item.resolve = resolve;
      item.reject = reject;
    });
    // A command goes before the reads still waiting (the start-up sweep).
    if (item.service === SERVICES.READ) {
      this.queue.push(item);
    } else {
      const index = this.queue.findIndex((queued) => queued.service === SERVICES.READ);
      this.queue.splice(index === -1 ? this.queue.length : index, 0, item);
    }
    this.pump();
    return promise;
  }

  flushQueue(err) {
    const items = this.queue.splice(0);
    for (const item of items) {
      item.reject(err);
    }
  }

  async pump() {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      while (this.state === 'connected' && this.queue.length > 0) {
        const item = this.queue.shift();
        this.inFlight = item;
        try {
          await this.transmit(item);
          item.resolve();
        } catch (err) {
          item.reject(err);
        } finally {
          this.inFlight = undefined;
        }
        await this.sleep(
          item.service === SERVICES.READ ? PACING.READ_SPACING : PACING.WRITE_SPACING,
        );
      }
    } finally {
      this.pumping = false;
    }
  }

  async transmit(item) {
    const channel = this.channel;
    const cemi = groupRequest({
      service: item.service,
      ga: item.ga,
      source: this.address ?? 0,
      payload: item.payload,
    });
    const sequence = this.outSequence;
    const confirmed = this.waitConfirm(item);
    try {
      if (this.protocol === 'udp') {
        let acked = false;
        let reason = 'no acknowledgement within 1 s';
        for (let attempt = 0; attempt < 2 && !acked; attempt += 1) {
          try {
            const ack = await this.request(
              tunnellingRequest(channel, sequence, cemi),
              SERVICE.TUNNELLING_ACK,
              TIMING.ACK_TIMEOUT,
              (frame) => frame.channel === channel && frame.sequence === sequence,
              this.dataEndpoint,
            );
            if (ack.status === STATUS.NO_ERROR) {
              acked = true;
            } else {
              reason = `acknowledged with ${statusName(ack.status)}`;
              if (ack.status === STATUS.CONNECTION_ID) {
                break;
              }
            }
          } catch (err) {
            if (err.code !== 'timeout') {
              throw err;
            }
          }
        }
        if (!acked) {
          const error = new KnxError('ack', `telegram to the gateway ${reason}`);
          this.lost(error);
          throw error;
        }
      } else {
        this.send(tunnellingRequest(channel, sequence, cemi));
      }
    } finally {
      this.outSequence = (sequence + 1) & 0xff;
    }
    this.counters.sent += 1;
    const confirmation = await confirmed;
    if (confirmation?.error) {
      throw new KnxError('bus', 'the gateway could not deliver the telegram on the bus');
    }
  }

  /**
   * The L_Data.con of the frame being sent. A gateway that never confirms
   * costs 3 s per telegram, nothing more: the telegram counts as sent.
   */
  waitConfirm(item) {
    return new Promise((resolve) => {
      const waiter = { ga: item.ga, service: item.service, resolve };
      waiter.timer = this.timers.setTimeout(() => {
        if (this.confirmWaiter === waiter) {
          this.confirmWaiter = undefined;
        }
        this.logger.debug?.('KNX: no L_Data.con within 3 s');
        resolve(undefined);
      }, TIMING.CONFIRM_TIMEOUT);
      this.confirmWaiter = waiter;
    });
  }
}

/**
 * The "Test" button: a separate, short-lived connection. `connect: false`
 * only asks for the description (the main tunnel is already up and an
 * interface often has a single tunnel to give).
 */
export async function probeGateway(options, { connect = true } = {}) {
  const tunnel = new KnxTunnel(options);
  const result = { description: undefined, address: undefined };
  try {
    if (connect) {
      await tunnel.connect();
      result.address = tunnel.address;
    } else {
      const transport = options.transportFactory ?? createTransport;
      tunnel.transport = transport({
        host: options.host,
        port: options.port,
        protocol: options.protocol,
        logger: options.logger ?? console,
        onFrame: (frame) => tunnel.handleFrame(frame),
      });
      await tunnel.withTimeout(tunnel.transport.open(), TIMING.CONNECT_TIMEOUT);
      tunnel.description = await tunnel.describe();
    }
    result.description = tunnel.description;
    return result;
  } finally {
    await tunnel.stop();
  }
}
