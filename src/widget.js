// -----------------------------------------------------------------------------
// The "KNX bus" widget: the state of the tunnel and the last group telegrams
// seen on the bus, a monitor to find an address while filling the device
// list. Pure.
//
// Budget: one status list, one focal card list (or the body text of the empty
// state), the caption saying the connector is unofficial.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { T } from './i18n.js';

const pick = (text, language) => (typeof text === 'string' ? text : (text[language] ?? text.en));

const BADGE_COLORS = {
  write: WIDGET_COLORS.PRIMARY,
  response: WIDGET_COLORS.INFO,
  read: WIDGET_COLORS.NEUTRAL,
};

/**
 * `gatewayName`: the name the gateway gave (or its address); `telegrams`:
 * newest first, each { at, groupAddress, deviceName, value, service, source }.
 */
export function busWidget({
  connected,
  gatewayName,
  address,
  received,
  declared,
  created,
  telegrams = [],
  language = 'en',
}) {
  const t = (text) => pick(text, language);
  const items = [
    {
      label: t(T.widget.gateway),
      value: (connected ? (gatewayName ?? t(T.widget.connected)) : t(T.widget.disconnected)).slice(
        0,
        40,
      ),
      icon: 'server',
      color: connected ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.DANGER,
    },
  ];
  if (connected && address) {
    items.push({ label: t(T.widget.tunnel), value: address, icon: 'git-branch' });
  }
  items.push({ label: t(T.widget.received), value: received, icon: 'activity' });
  items.push({ label: t(T.widget.devices), value: `${created} / ${declared}`, icon: 'grid' });
  const components = [{ type: 'status', items }];
  if (telegrams.length === 0) {
    components.push({ type: 'text', text: T.widget.empty, variant: 'body' });
  } else {
    components.push({
      type: 'card-list',
      display: 'list',
      items: telegrams.slice(0, 8).map((telegram) => ({
        title: `${telegram.groupAddress} → ${telegram.value}`.slice(0, 60),
        subtitle: `${telegram.deviceName ?? t(T.widget.unknown)} · ${t(T.widget.from)} ${telegram.source}`,
        date: telegram.at,
        badge: {
          text: t(T.widget.services[telegram.service]).slice(0, 16),
          color: BADGE_COLORS[telegram.service],
        },
      })),
    });
  }
  components.push({ type: 'text', text: T.widget.caption, variant: 'caption' });
  return { ttl_seconds: 30, components };
}
