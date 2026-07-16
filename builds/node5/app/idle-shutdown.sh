#!/bin/bash
# idle-shutdown.sh — Node 5 (GR86) "stay up ~15-30 min after ignition off, then
# sleep" run-mode guard.  STUB — see the README "known gaps".
#
# Run mode (user decision, MASTER_PLAN): on with ignition; a short parked window;
# then power down to protect the 12V battery. The real trigger is the supercap /
# UPS-HAT signalling loss of ignition power (a GPIO line goes low, or the hat
# raises a "on battery" flag). That wiring needs the physical Pi + hat.
#
# TODO (needs hardware):
#   * Read the UPS/supercap hat's "power good" GPIO (or its I2C battery gauge).
#   * When ignition power drops: start the grace window (GRACE_MIN); on expiry do
#     a CLEAN `systemctl poweroff` (flush FS -> protects the SD from 12V cuts).
#   * If ignition returns within the window, cancel the countdown.
#
# Until the hat is wired this stub is a documented placeholder that logs its
# intent and exits 0 (it MUST NOT power the car Pi down on a false read).
set -euo pipefail

GRACE_MIN="${GR86_GRACE_MIN:-20}"        # parked-coverage window, minutes
POWER_GOOD_GPIO="${GR86_POWER_GPIO:-}"   # e.g. gpiochip line for the hat's PWR_OK

# --- Real logic goes here once the hat is known -----------------------------
# if [ -n "$POWER_GOOD_GPIO" ] && ignition_power_lost "$POWER_GOOD_GPIO"; then
#   logger -t gr86-idle "ignition off — ${GRACE_MIN} min grace then poweroff"
#   sleep "$(( GRACE_MIN * 60 ))"
#   if ignition_power_lost "$POWER_GOOD_GPIO"; then
#     systemctl poweroff
#   fi
# fi
# ---------------------------------------------------------------------------

logger -t gr86-idle "idle-shutdown stub ran (grace=${GRACE_MIN}m, gpio='${POWER_GOOD_GPIO:-unset}') — no hat wired, no-op"
exit 0
