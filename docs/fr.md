# KNX

**Connecteur non officiel, sans lien avec la KNX Association.** Il relie Gladys
à une installation KNX par une interface ou un routeur KNXnet/IP de votre
réseau local : lumières, variateurs, volets, interrupteurs, capteurs et
thermostats, par adresse de groupe. Sans cloud et sans ETS. KNX est une marque
de la KNX Association.

## Ce qu'il faut

- Une **interface ou un routeur KNXnet/IP** (une « interface IP » ou un
  « routeur IP » dans votre tableau KNX) joignable depuis la machine Gladys,
  avec une **connexion tunnel** libre. Une interface en offre souvent de 1 à 8 ; ETS
  et tout autre logiciel connecté en même temps en prennent une chacun, cette
  intégration une.
- Les **adresses de groupe** de ce que vous voulez commander et lire : elles
  viennent de votre projet ETS (ou de votre installateur).

Pourquoi le tunnel et pas le routage : l'intégration tourne dans son propre
conteneur derrière le NAT de Docker, où le multicast KNX (224.0.23.12)
n'arrive jamais. Un routeur KNX IP est utilisé en mode tunnel, comme une
interface.

## Mise en route

1. Donnez une adresse IP fixe à la passerelle (une réservation DHCP dans votre
   box).
2. Installez l'intégration et saisissez l'**adresse de la passerelle**. Gardez
   le port 3671 et **UDP** sauf raison contraire : **TCP** ne marche qu'avec les
   passerelles KNXnet/IP 2 (« tunnelling v2 »), et se passe d'acquittement par
   télégramme.
3. Appuyez sur **Tester la passerelle** : le nom de la passerelle s'affiche,
   puis un tunnel s'ouvre et se referme.
4. Listez vos **appareils** (ci-dessous), enregistrez, puis ouvrez
   **Découverte** et ajoutez-les.
5. Facultatif : posez le widget **Bus KNX** sur un tableau de bord. Il montre
   les derniers télégrammes du bus : actionnez un interrupteur mural et son
   adresse de groupe apparaît, pratique pour remplir la liste.

## La liste des appareils

Un appareil par ligne (ou séparés par des virgules), les champs séparés par
des points-virgules :

```
type; nom; clé=adresse de groupe; clé=adresse de groupe; ...; option
```

Exemples :

```
light; Salon; switch=1/1/1; state=1/1/2
dimmer; Cuisine; switch=1/2/1; state=1/2/2; brightness=1/2/3; brightness_state=1/2/4
shutter; Chambre; move=2/1/1; stop=2/1/2; position=2/1/3; position_state=2/1/4
switch; Pompe; switch=3/1/1
sensor; Bureau; temperature=4/1/1; humidity=4/1/2
sensor; Compteur; power=4/2/1@9.024; energy=4/2/2@13.013
thermostat; Bureau; setpoint=5/1/1; setpoint_state=5/1/2; temperature=5/1/3; mode=5/1/4; mode_state=5/1/5
binary; Fenêtre; contact=6/1/1
# une ligne qui commence par # est un commentaire
```

| Type         | Clés (DPT)                                                                                                                                                                                                                                                                                      | Options  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `light`      | `switch` (1.001, obligatoire), `state` (1.001)                                                                                                                                                                                                                                                  |          |
| `dimmer`     | `switch`, `state` (1.001), `brightness`, `brightness_state` (5.001) ; `switch` ou `brightness` obligatoire                                                                                                                                                                                      |          |
| `shutter`    | `move` (1.008 montée/descente), `stop` (1.017), `position`, `position_state` (5.001) ; `move` ou `position` obligatoire                                                                                                                                                                         | `invert` |
| `switch`     | `switch` (1.001, obligatoire), `state` (1.001)                                                                                                                                                                                                                                                  |          |
| `sensor`     | `temperature` (9.001, 14.068), `humidity` (9.007, 5.001), `illuminance` ou `lux` (9.004), `co2` (9.008), `wind` (9.005, 9.028), `pressure` (9.006, 14.058), `power` (14.056, 9.024), `energy` (13.010, 13.013), `voltage` (14.027, 9.020), `current` (14.019, 9.021), `counter` (5.010, 13.001) |          |
| `thermostat` | `setpoint`, `setpoint_state` (9.001), `temperature` (9.001), `mode`, `mode_state` (20.102), `heating` (1.001)                                                                                                                                                                                   |          |
| `binary`     | `contact` (1.019), `motion`, `presence`, `smoke`, `leak` (1.x)                                                                                                                                                                                                                                  | `invert` |

- **Adresses de groupe** en trois niveaux (`1/2/3`), deux niveaux (`1/515`) ou
  libre (`2563`) : les trois désignent la même adresse.
- **Adresses de commande et d'état** : `switch`, `brightness`, `position`,
  `setpoint` et `mode` sont écrites par Gladys ; `state`, `brightness_state`,
  `position_state`, `setpoint_state`, `mode_state` et les capteurs sont lus à
  la connexion de l'intégration puis suivis. Donnez les adresses d'état quand
  vos actionneurs en ont : Gladys affiche alors l'état réel.
- **Un autre DPT** pour un capteur après `@` : `power=4/2/1@9.024` pour une
  puissance en kW sur deux octets. Gladys reçoit toujours des W, des kWh
  (l'énergie est un index de compteur, prêt pour le suivi de consommation),
  des V, A, hPa, m/s, lux, ppm, °C et %.
- `invert` sur un **volet** échange montée et descente et le sens de la
  position, pour les actionneurs réglés à l'envers ; sur un capteur **binary**
  il inverse la valeur (un contact qui envoie 1 quand il est fermé).
- Une erreur (type ou clé inconnus, adresse fausse, adresse manquante, deux
  fois le même nom pour un type) s'affiche dans l'état de l'intégration avec
  le numéro de l'appareil ; les autres appareils continuent de marcher.

### Renommer un appareil

L'identifiant d'un appareil vient de son **type et de son nom**, pas de sa
position : réordonnez la liste librement, et changez ses adresses librement.
Renommer un appareil (ou changer son type) en crée un nouveau dans
Découverte : ajoutez-le, puis supprimez l'ancien, dont les scènes sont à
mettre à jour.

## Ce que montre Gladys

- **Volets** : pour Gladys 100 % veut dire ouvert ; pour KNX 0 % veut dire
  ouvert (en haut). L'intégration convertit dans les deux sens ; `invert`
  garde le sens KNX.
- Les **contacts** (DPT 1.019, 1 = ouvert) deviennent des capteurs
  d'ouverture.
- **Modes de thermostat** (DPT 20.102) : auto ↔ programmation, confort ↔
  confort, veille ↔ éco, économie ↔ nuit, protection hors-gel ↔ hors-gel.
- Une mesure (température, puissance…) arrive dans Gladys au plus toutes les
  30 secondes par capteur, la dernière valeur l'emportant : un compteur qui
  émet chaque seconde n'inonde pas Gladys.

## Scènes

**Valeur de groupe KNX reçue** démarre une scène quand un appareil du bus
écrit sur une adresse de groupe : un bouton poussoir, une commande centrale,
un capteur qui envoie sa valeur. Laissez les champs vides pour tout accepter,
ou remplissez :

- **Adresse de groupe** : écrite comme dans l'option « Style des adresses de
  groupe » (trois niveaux par défaut, `7/1/1`) ;
- **Appareil** : un des appareils de la liste ;
- **Valeur** : `1` ou `0` pour un interrupteur ou un bouton poussoir, `21.5`
  pour une température, `comfort` pour un mode CVC, `+3` pour un pas de
  variation. Une adresse absente de la liste donne les valeurs sur 1 bit en
  `1` / `0` et les autres en octets hexadécimaux (`0c1a`).

Les variables : l'adresse de groupe, l'appareil, la valeur en texte et en
nombre, les octets bruts, le DPT et l'émetteur (adresse physique). Les
réponses aux lectures ne démarrent pas de scène, ni les télégrammes que
l'intégration envoie elle-même. Au plus 120 événements par minute, et le même
télégramme répété par le bus dans la seconde ne compte qu'une fois.

**Envoyer une valeur de groupe KNX** écrit une valeur sur une adresse de
groupe avec le DPT choisi : `1` (marche/arrêt, montée/descente : `1`, `0`,
`on`, `off`, `up`, `down`), `3.007` (`+1` à `+7`, `-1` à `-7`, `stop`),
`5.001` (0-100), `5.010` (0-255), `9` (un décimal), `13` (un entier), `14`
(un décimal), `17.001` (scène 1-64), `18.001` (`5`, ou `learn 5`), `20.102`
(`auto`, `comfort`, `standby`, `economy`, `building_protection`) ou `raw`
(octets en hexadécimal : `0C 1A`).

## Doux avec le bus

Un télégramme à la fois, chacun acquitté par la passerelle et confirmé sur le
bus avant le suivant, 100 ms après une écriture et 250 ms après une lecture.
Les adresses d'état sont lues une fois à chaque connexion, jamais
interrogées en boucle : le bus pousse chaque changement. Le tunnel est
vérifié toutes les 60 secondes et reconstruit après trois réponses
manquées ; la reconnexion attend 2 secondes, puis davantage, jusqu'à une
minute.

## Dépannage

- **Pas de réponse** : vérifiez l'adresse et le port, et que la machine Gladys
  atteint la passerelle (même réseau, pas de VLAN ni de pare-feu entre les
  deux).
- **Toutes les connexions tunnel de la passerelle sont occupées** : fermez ETS
  ou l'autre logiciel, ou libérez un tunnel dans les réglages de l'interface ;
  l'intégration réessaie chaque minute.
- **Un état ne s'affiche jamais** : l'adresse d'état doit avoir son drapeau
  « lecture » dans ETS pour répondre aux lectures, et son drapeau
  « transmission » pour envoyer ses changements.
- **Une valeur étrange** : le DPT de l'adresse n'est pas celui attendu ;
  choisissez-en un autre après `@` (capteurs) ou vérifiez l'adresse dans ETS.
- **TCP échoue, UDP marche** : la passerelle est KNXnet/IP 1 seulement ;
  gardez UDP.
- Journaux : le niveau de log de l'intégration se règle avec la variable
  `LOG_LEVEL`.

## Sécurité et vie privée

Tout reste sur votre réseau : l'intégration parle à la passerelle et à
Gladys, à rien d'autre. Un tunnel KNXnet/IP simple n'est pas chiffré ; KNX IP
Secure n'est pas encore pris en charge. Tout logiciel de votre réseau qui
atteint la passerelle peut en faire autant, c'est ainsi que fonctionne KNX :
gardez la passerelle sur un réseau de confiance.
