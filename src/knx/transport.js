// -----------------------------------------------------------------------------
// The ONLY network access of the integration: one UDP socket (dgram) or one
// TCP connection (net) to the KNXnet/IP gateway. Both come from a socket
// factory, so the tests plug in a fake gateway (test/helpers/fakeGateway.js)
// and the default factories throw there.
//
// UDP: one unicast socket on a random local port; frames go to the gateway's
// control endpoint (or the data endpoint it announced), and only frames from
// the gateway's address are accepted.
// TCP (KNXnet/IP 2): one stream, cut into frames by the header's total length.
// -----------------------------------------------------------------------------

import dgram from 'node:dgram';
import net from 'node:net';
import { FrameError, frameLength, parseFrame } from './frames.js';

let factories = {
  udp: () => dgram.createSocket({ type: 'udp4' }),
  tcp: ({ host, port }) => net.createConnection({ host, port }),
};

/** Replace the socket factories (tests only). Returns the previous ones. */
export function setSocketFactories(impl) {
  const previous = factories;
  factories = { ...factories, ...impl };
  return previous;
}

const isIp = (host) => net.isIP(host) !== 0;

export class UdpTransport {
  constructor({ host, port, onFrame, onClose = () => {}, logger = console }) {
    this.protocol = 'udp';
    this.host = host;
    this.port = port;
    this.onFrame = onFrame;
    this.onClose = onClose;
    this.logger = logger;
    this.socket = undefined;
    /** The address the gateway answers from (the host when it is an IP). */
    this.peer = isIp(host) ? host : undefined;
  }

  open() {
    const socket = factories.udp();
    this.socket = socket;
    socket.on('message', (message, rinfo) => {
      if (this.socket !== socket) {
        return;
      }
      if (this.peer === undefined) {
        this.peer = rinfo?.address;
      } else if (rinfo?.address && rinfo.address !== this.peer) {
        this.logger.debug?.(`KNX: ignored a datagram from ${rinfo.address}`);
        return;
      }
      let frame;
      try {
        frame = parseFrame(message);
      } catch (err) {
        this.logger.debug?.(`KNX: ignored a malformed frame: ${err.message}`);
        return;
      }
      this.onFrame(frame);
    });
    socket.on('error', (err) => {
      if (this.socket === socket) {
        this.logger.warn(`KNX UDP socket error: ${err.message}`);
      }
    });
    return new Promise((resolve, reject) => {
      try {
        socket.bind(0, () => resolve());
      } catch (err) {
        reject(err);
      }
    });
  }

  /** Send to the control endpoint, or to `endpoint` ({ host, port }). */
  send(buffer, endpoint) {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    socket.send(buffer, endpoint?.port ?? this.port, endpoint?.host ?? this.host, (err) => {
      if (err && this.socket === socket) {
        this.logger.warn(`KNX UDP send failed: ${err.message}`);
      }
    });
  }

  close() {
    const socket = this.socket;
    this.socket = undefined;
    try {
      socket?.close();
    } catch {
      // already closed
    }
  }
}

export class TcpTransport {
  constructor({ host, port, onFrame, onClose = () => {}, logger = console }) {
    this.protocol = 'tcp';
    this.host = host;
    this.port = port;
    this.onFrame = onFrame;
    this.onClose = onClose;
    this.logger = logger;
    this.socket = undefined;
    this.buffer = Buffer.alloc(0);
  }

  open() {
    const socket = factories.tcp({ host: this.host, port: this.port });
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    socket.setNoDelay?.(true);
    return new Promise((resolve, reject) => {
      let opened = false;
      socket.on('connect', () => {
        opened = true;
        resolve();
      });
      socket.on('data', (chunk) => {
        if (this.socket === socket) {
          this.receive(chunk);
        }
      });
      socket.on('error', (err) => {
        if (!opened) {
          reject(err);
        } else if (this.socket === socket) {
          this.logger.warn(`KNX TCP error: ${err.message}`);
        }
      });
      socket.on('close', () => {
        if (!opened) {
          reject(new Error('connection closed'));
        } else if (this.socket === socket) {
          this.socket = undefined;
          this.onClose('closed');
        }
      });
    });
  }

  /** Cut the stream into frames; a header that is not KNXnet/IP ends it. */
  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      let length;
      try {
        length = frameLength(this.buffer);
      } catch (err) {
        this.logger.warn(`KNX TCP stream out of sync: ${err.message}`);
        this.close();
        this.onClose('stream');
        return;
      }
      if (length === undefined || this.buffer.length < length) {
        return;
      }
      const raw = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      try {
        this.onFrame(parseFrame(raw));
      } catch (err) {
        if (!(err instanceof FrameError)) {
          throw err;
        }
        this.logger.debug?.(`KNX: ignored a malformed frame: ${err.message}`);
      }
    }
  }

  send(buffer) {
    this.socket?.write(buffer);
  }

  close() {
    const socket = this.socket;
    this.socket = undefined;
    try {
      socket?.destroy();
    } catch {
      // already closed
    }
  }
}

/** The transport of a protocol ('udp' or 'tcp'). */
export function createTransport(options) {
  return options.protocol === 'tcp' ? new TcpTransport(options) : new UdpTransport(options);
}
