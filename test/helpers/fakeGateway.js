// -----------------------------------------------------------------------------
// A fake KNXnet/IP gateway, written byte by byte from the specification (KNX
// 03.08.02 Core, 03.08.04 Tunnelling, 03.06.03 cEMI) and NOT with the encoders
// of src/knx: a mistake in them cannot cancel itself out here.
//
// It plays the gateway behind the dgram / net socket factories: answers the
// description, the connection, the heartbeat, acknowledges and confirms the
// telegrams, and sends telegrams of the bus. No test opens a real socket: the
// default factories throw.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { setSocketFactories } from '../../src/knx/transport.js';

setSocketFactories({
  udp: () => {
    throw new Error('Real UDP socket opened in a test');
  },
  tcp: () => {
    throw new Error('Real TCP connection opened in a test');
  },
});

export const hex = (text) => Buffer.from(text.replace(/\s+/g, ''), 'hex');

/** The DESCRIPTION_RESPONSE of a real "KNX/IP-Router" (from the xknx test suite). */
export const ROUTER_DESCRIPTION = hex(
  '06 10 02 04 00 48 36 01 02 00 10 00 00 00 00 08' +
    '2d 40 83 4d e0 00 17 0c 00 0a b3 27 4a 32 4b 4e' +
    '58 2f 49 50 2d 52 6f 75 74 65 72 00 00 00 00 00' +
    '00 00 00 00 00 00 00 00 00 00 00 00 0c 02 02 02' +
    '03 02 04 02 05 02 07 01',
);

const frame = (service, body) => {
  const length = 6 + body.length;
  return Buffer.from([
    0x06,
    0x10,
    service >> 8,
    service & 0xff,
    length >> 8,
    length & 0xff,
    ...body,
  ]);
};

/** "1/2/3" -> raw, written here by hand on purpose. */
export const ga = (text) => {
  const [main, middle, sub] = text.split('/').map(Number);
  return (main << 11) | (middle << 8) | sub;
};

/** An L_Data.ind of the bus: GroupValue_Write (0x80) or _Response (0x40). */
export function indication({ to, value, source = 0x1116, apci = 0x80 }) {
  const address = typeof to === 'string' ? ga(to) : to;
  const tpdu =
    typeof value === 'number' ? [0x00, apci | (value & 0x3f)] : [0x00, apci, ...hex(value)];
  return Buffer.from([
    0x29,
    0x00,
    0xbc,
    0xd0,
    source >> 8,
    source & 0xff,
    address >> 8,
    address & 0xff,
    tpdu.length - 1,
    ...tpdu,
  ]);
}

export class FakeGateway {
  constructor({
    protocol = 'udp',
    ip = '192.168.1.10',
    port = 3671,
    channel = 21,
    tunnelAddress = 0x11ff,
  } = {}) {
    this.protocol = protocol;
    this.ip = ip;
    this.port = port;
    this.channel = channel;
    this.tunnelAddress = tunnelAddress;
    /** What the gateway does; the tests switch these off. */
    this.answers = {
      description: true,
      connect: true,
      connectStatus: 0x00,
      heartbeat: true,
      ack: true,
      confirm: true,
      confirmError: false,
    };
    this.down = false;
    this.connected = false;
    this.tunnelSocket = undefined;
    this.serverSequence = 0;
    /** Every frame received, and the parts the tests look at. */
    this.frames = [];
    this.requests = [];
    this.acks = [];
    this.sockets = [];
  }

  /** The frames received of one service type (0x0205...). */
  received(service) {
    return this.frames.filter((f) => ((f[2] << 8) | f[3]) === service);
  }

  /** A frame from the client, on `socket`. */
  receive(buffer, socket) {
    this.frames.push(Buffer.from(buffer));
    if (this.down) {
      return;
    }
    const service = (buffer[2] << 8) | buffer[3];
    const body = buffer.subarray(6);
    switch (service) {
      case 0x0203:
        if (this.answers.description) {
          socket.deliver(ROUTER_DESCRIPTION);
        }
        break;
      case 0x0205: {
        if (!this.answers.connect) {
          break;
        }
        if (this.answers.connectStatus !== 0) {
          // As an MDT interface does: no HPAI, no CRD after an error.
          socket.deliver(frame(0x0206, [0x00, this.answers.connectStatus]));
          break;
        }
        this.connected = true;
        this.tunnelSocket = socket;
        this.serverSequence = 0;
        const ip = this.ip.split('.').map(Number);
        socket.deliver(
          frame(0x0206, [
            this.channel,
            0x00,
            0x08,
            this.protocol === 'tcp' ? 0x02 : 0x01,
            ...ip,
            this.port >> 8,
            this.port & 0xff,
            0x04,
            0x04,
            this.tunnelAddress >> 8,
            this.tunnelAddress & 0xff,
          ]),
        );
        break;
      }
      case 0x0207:
        if (this.answers.heartbeat) {
          const ok = this.connected && body[0] === this.channel;
          socket.deliver(frame(0x0208, [body[0], ok ? 0x00 : 0x21]));
        }
        break;
      case 0x0209:
        socket.deliver(frame(0x020a, [body[0], 0x00]));
        if (body[0] === this.channel) {
          this.connected = false;
        }
        break;
      case 0x0420: {
        const request = {
          channel: body[1],
          sequence: body[2],
          cemi: Buffer.from(body.subarray(4)),
        };
        this.requests.push(request);
        if (this.protocol === 'udp' && this.answers.ack) {
          socket.deliver(frame(0x0421, [0x04, body[1], body[2], 0x00]));
        }
        if (this.answers.confirm) {
          const confirmation = Buffer.from(request.cemi);
          confirmation[0] = 0x2e;
          if (this.answers.confirmError) {
            confirmation[2] |= 0x01;
          }
          this.indicate(confirmation);
        }
        break;
      }
      case 0x0421:
        this.acks.push({ channel: body[1], sequence: body[2], status: body[3] });
        break;
      default:
        break;
    }
  }

  /** A TUNNELLING_REQUEST from the gateway (a telegram of the bus, a confirmation). */
  indicate(cemi, { sequence } = {}) {
    const seq = sequence ?? this.serverSequence;
    if (sequence === undefined) {
      this.serverSequence = (this.serverSequence + 1) & 0xff;
    }
    this.tunnelSocket?.deliver(frame(0x0420, [0x04, this.channel, seq, 0x00, ...cemi]));
  }

  /** The gateway ends the tunnel itself. */
  disconnect() {
    this.connected = false;
    this.tunnelSocket?.deliver(frame(0x0209, [this.channel, 0x00, 0x08, 0x01, 0, 0, 0, 0, 0, 0]));
  }
}

class FakeUdpSocket extends EventEmitter {
  constructor(gateway) {
    super();
    this.gateway = gateway;
    this.closed = false;
    this.sent = [];
  }

  bind(_port, callback) {
    queueMicrotask(() => callback?.());
    return this;
  }

  send(buffer, port, host, callback) {
    this.sent.push({ buffer: Buffer.from(buffer), port, host });
    this.remote = host;
    queueMicrotask(() => callback?.(null));
    if (!this.closed) {
      this.gateway.receive(Buffer.from(buffer), this);
    }
  }

  close() {
    this.closed = true;
  }

  /** An answer comes from the address the client sent to (the gateway's own by default). */
  deliver(buffer, from = this.remote ?? this.gateway.ip) {
    queueMicrotask(() => {
      if (!this.closed) {
        this.emit('message', buffer, { address: from, port: this.gateway.port });
      }
    });
  }
}

class FakeTcpSocket extends EventEmitter {
  constructor(gateway) {
    super();
    this.gateway = gateway;
    this.destroyed = false;
    this.sent = [];
    /** Cut every answer in two chunks, to exercise the stream framing. */
    this.split = true;
    queueMicrotask(() => {
      if (gateway.down) {
        this.emit('error', new Error('connect ECONNREFUSED'));
        this.emit('close');
      } else {
        this.emit('connect');
      }
    });
  }

  setNoDelay() {}

  write(buffer) {
    this.sent.push(Buffer.from(buffer));
    if (!this.destroyed) {
      this.gateway.receive(Buffer.from(buffer), this);
    }
  }

  destroy() {
    if (!this.destroyed) {
      this.destroyed = true;
      queueMicrotask(() => this.emit('close'));
    }
  }

  deliver(buffer) {
    const cut = this.split ? Math.ceil(buffer.length / 2) : buffer.length;
    queueMicrotask(() => {
      if (!this.destroyed) {
        this.emit('data', buffer.subarray(0, cut));
        if (cut < buffer.length) {
          this.emit('data', buffer.subarray(cut));
        }
      }
    });
  }
}

/** Plug a fake gateway behind the socket factories. */
export function installGateway(options = {}) {
  const gateway = new FakeGateway(options);
  const previous = setSocketFactories({
    udp: () => {
      const socket = new FakeUdpSocket(gateway);
      gateway.sockets.push(socket);
      return socket;
    },
    tcp: () => {
      const socket = new FakeTcpSocket(gateway);
      gateway.sockets.push(socket);
      return socket;
    },
  });
  return { gateway, restore: () => setSocketFactories(previous) };
}
