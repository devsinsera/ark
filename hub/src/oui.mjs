// Small embedded OUI (MAC vendor) lookup table.
// Covers the prefixes commonly seen on a home LAN — Raspberry Pi
// (critical for Ark), Apple, common router brands, IoT chipsets,
// Huawei mesh, etc. Extend as needed.

const OUI = {
  // Raspberry Pi — ALL prefixes assigned by IEEE to Raspberry Pi Ltd /
  // Raspberry Pi Trading. These are the ones Ark cares about most.
  // Confirmed via live Pi 5 ("SinseraCore") on user's LAN: MAC 88:a2:9e:*
  'b8:27:eb': 'Raspberry Pi',
  'dc:a6:32': 'Raspberry Pi',
  '28:cd:c1': 'Raspberry Pi',
  'e4:5f:01': 'Raspberry Pi',
  '2c:cf:67': 'Raspberry Pi',
  'd8:3a:dd': 'Raspberry Pi',
  '88:a2:9e': 'Raspberry Pi',          // newer Pi 5 prefix
  '3a:35:41': 'Raspberry Pi',
  'c0:3c:59': 'Raspberry Pi',
  '4c:11:bf': 'Raspberry Pi',

  // Apple
  '04:99:b9': 'Apple',
  '10:2c:b1': 'Apple',
  '3c:84:27': 'Apple',
  '14:14:7d': 'Apple',
  // 54:ef:44 was previously mis-attributed to Apple. IEEE has it
  // registered to Lumi United Technology (Aqara's parent company) —
  // covers Aqara Hubs, sensors, and the M100 Matter bridge.
  'c4:f7:c1': 'Apple',
  '88:66:5a': 'Apple',
  'a4:83:e7': 'Apple',
  'f4:5c:89': 'Apple',
  '00:23:32': 'Apple',
  '40:33:1a': 'Apple',
  '64:b0:a6': 'Apple',
  '8c:85:90': 'Apple',
  'd0:e1:40': 'Apple',
  'f0:db:f8': 'Apple',

  // Networking / router brands
  '30:3a:4a': 'Belkin International',
  '00:25:9c': 'Cisco-Linksys',
  '74:da:da': 'D-Link',
  'ec:08:6b': 'TP-Link',
  '98:5f:d3': 'TP-Link',
  '50:c7:bf': 'TP-Link',
  '14:eb:b6': 'TP-Link',
  '00:1f:33': 'Netgear',
  '10:da:43': 'Netgear',
  'b0:b9:8a': 'Netgear',
  '14:cc:20': 'TP-Link',
  '60:38:e0': 'Belkin',

  // Aqara / Lumi smart-home (Zigbee hubs, sensors, M100 Matter bridge)
  '54:ef:44': 'Aqara (Lumi United)',
  '04:cf:8c': 'Aqara (Lumi United)',
  '7c:49:eb': 'Aqara (Lumi United)',

  // Huawei mesh / WiFi extenders
  '48:e1:e9': 'Murata (commonly Huawei mesh)',
  '48:e1:5c': 'Liteon (commonly mesh node)',
  'a4:6b:1f': 'Huawei',

  // ESP IoT chipsets — ESP32 / ESP8266
  '08:3a:8d': 'Espressif (ESP32/ESP8266 IoT)',
  '8c:aa:b5': 'Espressif',
  '24:6f:28': 'Espressif',
  'cc:50:e3': 'Espressif',
  '3c:71:bf': 'Espressif',

  // Samsung
  '00:21:19': 'Samsung',
  '5c:0a:5b': 'Samsung',
  '78:1f:db': 'Samsung',

  // Google / Nest
  'f4:f5:d8': 'Google',
  '20:df:b9': 'Google Nest',

  // Amazon
  '74:c2:46': 'Amazon (Echo / Fire)',
  '50:f5:da': 'Amazon',

  // Sonos
  '5c:aa:fd': 'Sonos',

  // Roku / TV
  'cc:6d:a0': 'Roku',
  'ac:ae:19': 'Roku',
  'b0:a7:37': 'Roku',

  // Philips Hue / IoT
  '00:17:88': 'Philips Hue',

  // Printers
  '00:80:77': 'Brother',
  '38:f9:d3': 'HP',
};

export function vendorForMac(mac) {
  if (!mac) return null;
  const m = mac.toLowerCase().split(/[-:]/).map(p => p.length === 1 ? '0' + p : p).join(':');
  // Locally Administered MAC (random / privacy): bit 1 of first octet is 1.
  // These belong to no vendor — they're a per-session randomised address,
  // typically iOS/Android private WiFi MAC.
  const firstOctet = parseInt(m.slice(0, 2), 16);
  if ((firstOctet & 0x02) === 0x02) return 'Locally administered (private MAC)';
  const prefix = m.slice(0, 8);  // first 3 octets, with colons
  return OUI[prefix] || null;
}

export function isLikelyPi(mac) {
  if (!mac) return false;
  const m = mac.toLowerCase().split(/[-:]/).map(p => p.length === 1 ? '0' + p : p).join(':');
  return [
    'b8:27:eb', 'dc:a6:32', '28:cd:c1', 'e4:5f:01',
    '2c:cf:67', 'd8:3a:dd', '88:a2:9e', '3a:35:41',
    'c0:3c:59', '4c:11:bf',
  ].some(p => m.startsWith(p));
}
