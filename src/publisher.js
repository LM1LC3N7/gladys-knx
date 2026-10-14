// -----------------------------------------------------------------------------
// The states sent to Gladys, at a pace the core accepts (300 states a minute
// per integration). A switch, a position, a contact go out at once; a
// measurement (temperature, power...) at most every 30 s per feature, the
// latest value winning: an energy meter sending every second costs Gladys
// two states a minute, not sixty.
// -----------------------------------------------------------------------------

import { PACING } from './constants.js';

const defaultTimers = { setTimeout, clearTimeout };

export class StatePublisher {
  constructor({
    gladys,
    logger = console,
    timers = defaultTimers,
    now = Date.now,
    interval = PACING.SENSOR_STATE_INTERVAL,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.timers = timers;
    this.now = now;
    this.interval = interval;
    /** feature id -> when its last measurement went out */
    this.sentAt = new Map();
    /** feature id -> { value, timer } waiting for its slot */
    this.pending = new Map();
  }

  push(featureId, value, { measurement = false } = {}) {
    if (!measurement) {
      return this.send([{ device_feature_external_id: featureId, state: value }]);
    }
    const now = this.now();
    const waiting = this.pending.get(featureId);
    if (waiting) {
      waiting.value = value;
      return Promise.resolve();
    }
    const last = this.sentAt.get(featureId);
    if (last === undefined || now - last >= this.interval) {
      this.sentAt.set(featureId, now);
      return this.send([{ device_feature_external_id: featureId, state: value }]);
    }
    const entry = { value };
    entry.timer = this.timers.setTimeout(
      () => {
        this.pending.delete(featureId);
        this.sentAt.set(featureId, this.now());
        this.send([{ device_feature_external_id: featureId, state: entry.value }]);
      },
      this.interval - (now - last),
    );
    this.pending.set(featureId, entry);
    return Promise.resolve();
  }

  send(states) {
    return this.gladys
      .publishChangedStates(states, { heartbeat: PACING.STATE_HEARTBEAT })
      .catch((err) => this.logger.warn(`Publishing KNX states failed: ${err.message}`));
  }

  stop() {
    for (const entry of this.pending.values()) {
      this.timers.clearTimeout(entry.timer);
    }
    this.pending.clear();
  }
}
