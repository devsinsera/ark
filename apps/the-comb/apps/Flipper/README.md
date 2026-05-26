# Flipper

Slot reserved for [Flipper Zero](https://flipperzero.one) integration
inside The Haunted Broccoli.

Intended scope: when a Flipper is plugged into the host via USB, THB
detects it and exposes a `/apps/flipper` route with:
- Live status (firmware version, battery, current app)
- File browser into the Flipper SD card (CLI over serial)
- Backup / restore of the SD card contents to local storage
- A library of signed `.sub` / `.rfid` / `.ir` files that can be
  pushed to the Flipper
- Sync with the Flipper community's `flipperzero-firmware` builds

Detection: Flipper Zero advertises as USB VID `0x0483` + PID `0x5740`
(STMicro Virtual COM Port). Same `/api/device`-style detection pattern
as the iOS path, but parses serial protocol responses instead of
libimobiledevice fields.

Current state: empty stub.
