// -----------------------------------------------------------------------------
// Group telegrams -> the "group value received" scene event. Pure.
//
// Only a GroupValue_Write is an event: something happened on the bus (a push
// button, a central command, a sensor sending its value). The answers to the
// reads (GroupValue_Response, our start-up sweep among them) only update
// states: the first reading fires nothing. Our own writes come back as
// L_Data.con, never as an indication: a scene that writes cannot trigger
// itself through this integration.
//
// The core matches the fields by equality: `group_address` is always written
// in the configured style (three levels by default), `value` is a canonical
// text ("1", "21.5", "comfort", "+3").
// -----------------------------------------------------------------------------

import { PACING, SCENE_TRIGGERS } from './constants.js';
import { formatGroupAddress, formatIndividualAddress } from './knx/address.js';
import { decode, payloadHex, valueNumber, valueText } from './knx/dpt.js';

/**
 * The event of a GroupValue_Write, or undefined. `listeners` comes from
 * listenersOf(); `deviceIdOf(definition)` gives the Gladys external id.
 */
export function groupValueEvent(telegram, { listeners, deviceIdOf, style, eventAddresses }) {
  if (telegram.service !== 'write') {
    return undefined;
  }
  if (eventAddresses && !eventAddresses.has(telegram.ga)) {
    return undefined;
  }
  const raw = payloadHex(telegram.payload);
  const data = {
    group_address: formatGroupAddress(telegram.ga, style),
    device: null,
    device_name: null,
    value: null,
    number: null,
    raw,
    dpt: null,
    source: formatIndividualAddress(telegram.source),
  };
  for (const { definition, key } of listeners.get(telegram.ga) ?? []) {
    const dpt = definition.addresses[key].dpt;
    try {
      const value = decode(dpt, telegram.payload);
      Object.assign(data, {
        device: deviceIdOf(definition),
        device_name: definition.name,
        value: valueText(dpt, value),
        number: valueNumber(dpt, value),
        dpt,
      });
      break;
    } catch {
      // A payload that does not fit this DPT: try the next device, else raw.
    }
  }
  if (data.value === null) {
    // Undeclared: a small value is a number anyway (a push button: 1 / 0).
    if (telegram.payload.small) {
      data.value = String(telegram.payload.value);
      data.number = telegram.payload.value;
    } else {
      data.value = raw;
    }
  }
  return { key: SCENE_TRIGGERS.GROUP_VALUE, data };
}

/**
 * The gate of the scene events: the same telegram again within a second (a
 * bus repetition) is dropped, and at most EVENTS_PER_MINUTE pass per minute.
 */
export class EventGate {
  constructor({
    now = Date.now,
    window = PACING.DUPLICATE_WINDOW,
    perMinute = PACING.EVENTS_PER_MINUTE,
  } = {}) {
    this.now = now;
    this.window = window;
    this.perMinute = perMinute;
    this.last = new Map();
    this.minuteStart = 0;
    this.count = 0;
    this.dropped = 0;
  }

  /** true when the event may be published. */
  admit(event) {
    const now = this.now();
    const signature = `${event.data.group_address}|${event.data.raw}|${event.data.source}`;
    const previous = this.last.get(event.data.group_address);
    this.last.set(event.data.group_address, { signature, at: now });
    if (previous && previous.signature === signature && now - previous.at < this.window) {
      return false;
    }
    if (now - this.minuteStart >= 60_000) {
      this.minuteStart = now;
      this.count = 0;
    }
    if (this.count >= this.perMinute) {
      this.dropped += 1;
      return false;
    }
    this.count += 1;
    return true;
  }
}
