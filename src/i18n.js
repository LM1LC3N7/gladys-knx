// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, action results, widget).
// Every text is a { en, fr } object.
// -----------------------------------------------------------------------------

import { FAMILY_TUNNELLING, MEDIUM_NAMES } from './knx/frames.js';
import { formatIndividualAddress } from './knx/address.js';

const TYPES = 'light, dimmer, shutter, switch, sensor, thermostat, binary';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? 's' : ''}`;

/** Why the gateway cannot be used, from a KnxError (src/knx/tunnel.js). */
export function reasonOf(err) {
  const detail = err?.message ?? String(err);
  switch (err?.code) {
    case 'timeout':
      return {
        en: 'no answer (check the address, the port, and that the gateway is powered)',
        fr: 'pas de réponse (vérifiez l’adresse, le port et que la passerelle est alimentée)',
      };
    case 'busy':
      return {
        en: 'every tunnelling connection of the gateway is in use (ETS or another software?)',
        fr: 'toutes les connexions tunnel de la passerelle sont occupées (ETS ou un autre logiciel ?)',
      };
    case 'refused':
      return { en: `the gateway refused: ${detail}`, fr: `la passerelle a refusé : ${detail}` };
    case 'closed':
      return {
        en: 'the gateway closed the tunnel',
        fr: 'la passerelle a fermé le tunnel',
      };
    case 'lost':
    case 'ack':
      return { en: `tunnel lost: ${detail}`, fr: `tunnel perdu : ${detail}` };
    default:
      return { en: `network error: ${detail}`, fr: `erreur réseau : ${detail}` };
  }
}

/** One grammar error of the `devices` field (src/config.js). */
export function grammarError(error) {
  const n = error.index;
  const d = error.detail;
  switch (error.code) {
    case 'type':
      return {
        en: `Device #${n}: unknown type "${d}" (${TYPES}).`,
        fr: `Appareil n°${n} : type « ${d} » inconnu (${TYPES}).`,
      };
    case 'name':
      return {
        en: `Device #${n}: a name must follow the type (letters or digits, 60 characters at most).`,
        fr: `Appareil n°${n} : un nom doit suivre le type (lettres ou chiffres, 60 caractères au plus).`,
      };
    case 'key':
      return {
        en: `Device #${n}: "${d}" is unknown for this type (${error.allowed.join(', ')}).`,
        fr: `Appareil n°${n} : « ${d} » est inconnu pour ce type (${error.allowed.join(', ')}).`,
      };
    case 'duplicate_key':
      return {
        en: `Device #${n}: "${d}" is given twice.`,
        fr: `Appareil n°${n} : « ${d} » est donné deux fois.`,
      };
    case 'address':
      if (error.reason === 'broadcast') {
        return {
          en: `Device #${n}: 0/0/0 is the broadcast address, not a group address.`,
          fr: `Appareil n°${n} : 0/0/0 est l’adresse de diffusion, pas une adresse de groupe.`,
        };
      }
      return {
        en: `Device #${n}: "${d}" is not a group address (1/2/3 up to 31/7/255, 1/515 or 2563).`,
        fr: `Appareil n°${n} : « ${d} » n’est pas une adresse de groupe (1/2/3 jusqu’à 31/7/255, 1/515 ou 2563).`,
      };
    case 'dpt':
      return {
        en: `Device #${n}: DPT ${d} is not available here (${error.allowed.join(', ')}).`,
        fr: `Appareil n°${n} : le DPT ${d} n’est pas disponible ici (${error.allowed.join(', ')}).`,
      };
    case 'missing':
      return {
        en: `Device #${n}: an address is missing (${d}).`,
        fr: `Appareil n°${n} : il manque une adresse (${d}).`,
      };
    case 'duplicate':
      return {
        en: `Device #${n}: a device of the same type is already named "${d}".`,
        fr: `Appareil n°${n} : un appareil du même type s’appelle déjà « ${d} ».`,
      };
    default:
      return {
        en: `Only the first ${d} devices are used.`,
        fr: `Seuls les ${d} premiers appareils sont utilisés.`,
      };
  }
}

/** The first two grammar errors, and how many more. */
export function errorsSummary(errors) {
  const shown = errors.slice(0, 2).map(grammarError);
  const more = errors.length - shown.length;
  return {
    en: [...shown.map((e) => e.en), ...(more > 0 ? [`And ${more} more.`] : [])].join(' '),
    fr: [...shown.map((e) => e.fr), ...(more > 0 ? [`Et ${more} de plus.`] : [])].join(' '),
  };
}

/** Several texts in one, the empty ones left out. */
const join = (...texts) => {
  const kept = texts.filter((t) => t && (t.en || t.fr));
  return { en: kept.map((t) => t.en).join(' '), fr: kept.map((t) => t.fr).join(' ') };
};

export const T = {
  join,
  noHost: {
    en: 'Type the IP address of your KNXnet/IP interface or router in the configuration.',
    fr: 'Saisissez l’adresse IP de votre interface ou routeur KNXnet/IP dans la configuration.',
  },
  connecting: (host) => ({
    en: `Connecting to the KNX gateway ${host}…`,
    fr: `Connexion à la passerelle KNX ${host}…`,
  }),
  ok: ({ gateway, address, declared, created }) => ({
    en: `Tunnel open to ${gateway} as ${address}: ${plural(declared, 'device')} declared, ${created} created.`,
    fr: `Tunnel ouvert vers ${gateway} en ${address} : ${pluriel(declared, 'appareil')} ${declared > 1 ? 'déclarés' : 'déclaré'}, ${created} ${created > 1 ? 'créés' : 'créé'}.`,
  }),
  noDevice: {
    en: 'No device declared yet: list your devices and their group addresses in the configuration.',
    fr: 'Aucun appareil déclaré : listez vos appareils et leurs adresses de groupe dans la configuration.',
  },
  unreachable: (host, reason, retryInMs) => ({
    en: `KNX gateway ${host} unreachable: ${reason.en}.${retryInMs ? ` Next attempt in ${Math.round(retryInMs / 1000)} s.` : ''}`,
    fr: `Passerelle KNX ${host} injoignable : ${reason.fr}.${retryInMs ? ` Nouvel essai dans ${Math.round(retryInMs / 1000)} s.` : ''}`,
  }),
  invalidEventAddresses: (list) => ({
    en: `Ignored in "Group addresses that fire the trigger": ${list.join(', ')}.`,
    fr: `Ignoré dans « Adresses de groupe qui déclenchent » : ${list.join(', ')}.`,
  }),
  notConnected: {
    en: 'The KNX tunnel is not connected: the telegram was not sent.',
    fr: 'Le tunnel KNX n’est pas connecté : le télégramme n’a pas été envoyé.',
  },
  /** The description of a gateway: "KNX IP Router (1.0.0, TP1, tunnelling v2)". */
  gateway: (description, host) => {
    if (!description?.name) {
      return host;
    }
    const parts = [];
    if (description.address !== undefined) {
      parts.push(formatIndividualAddress(description.address));
    }
    if (MEDIUM_NAMES[description.medium]) {
      parts.push(MEDIUM_NAMES[description.medium]);
    }
    const tunnelling = description.families?.find((f) => f.family === FAMILY_TUNNELLING);
    if (tunnelling) {
      parts.push(`tunnelling v${tunnelling.version}`);
    }
    return `"${description.name}" (${host}${parts.length ? `, ${parts.join(', ')}` : ''})`;
  },
  test: {
    described: (gateway) => ({
      en: `The gateway answers: ${gateway}.`,
      fr: `La passerelle répond : ${gateway}.`,
    }),
    noDescription: {
      en: 'The gateway gave no description (it answered the connection all the same).',
      fr: 'La passerelle n’a pas donné de description (elle a accepté la connexion quand même).',
    },
    tunnel: (address) => ({
      en: `A tunnel opened as ${address} and closed again: the integration can use it.`,
      fr: `Un tunnel s’est ouvert en ${address} puis s’est refermé : l’intégration peut l’utiliser.`,
    }),
    running: (address, received, sent) => ({
      en: `The integration's tunnel is open as ${address}: ${received} telegrams received, ${sent} sent.`,
      fr: `Le tunnel de l’intégration est ouvert en ${address} : ${received} télégrammes reçus, ${sent} envoyés.`,
    }),
    failed: (host, reason) => ({
      en: `The gateway ${host} cannot be used: ${reason.en}.`,
      fr: `La passerelle ${host} est inutilisable : ${reason.fr}.`,
    }),
    tcpHint: {
      en: 'TCP needs a KNXnet/IP 2 gateway (tunnelling v2): try UDP otherwise.',
      fr: 'TCP demande une passerelle KNXnet/IP 2 (tunnelling v2) : sinon, essayez UDP.',
    },
  },
  widget: {
    title: { en: 'KNX bus', fr: 'Bus KNX' },
    gateway: { en: 'Gateway', fr: 'Passerelle' },
    connected: { en: 'Connected', fr: 'Connectée' },
    disconnected: { en: 'Disconnected', fr: 'Déconnectée' },
    tunnel: { en: 'Tunnel address', fr: 'Adresse du tunnel' },
    received: { en: 'Telegrams received', fr: 'Télégrammes reçus' },
    devices: { en: 'Devices', fr: 'Appareils' },
    empty: {
      en: 'No telegram seen yet: operate a switch to see it here.',
      fr: 'Aucun télégramme vu : actionnez un interrupteur pour le voir ici.',
    },
    unknown: { en: 'undeclared address', fr: 'adresse non déclarée' },
    from: { en: 'from', fr: 'de' },
    caption: {
      en: 'Unofficial connector, not affiliated with the KNX Association',
      fr: 'Connecteur non officiel, sans lien avec la KNX Association',
    },
    services: {
      write: { en: 'Write', fr: 'Écriture' },
      response: { en: 'Response', fr: 'Réponse' },
      read: { en: 'Read', fr: 'Lecture' },
    },
  },
};
