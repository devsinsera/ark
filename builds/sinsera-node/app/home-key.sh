#!/bin/sh
# Kiosk keyboard "Home" key → return to the Sinsera Command Centre (not chromium's
# built-in homepage). Bound to XF86HomePage in openbox rc.xml. In --kiosk there is
# no address bar, so we point the relaunch loop's URL file at the Command Centre and
# bounce chromium; the profile keeps the login, so it returns authenticated.
CC="https://sinsera.co/?kiosk=1&node=$(hostname)&cc=1"
echo "$CC" > /tmp/kiosk_url
pkill -f "chromium.*--user-data-dir=/home/kiosk/.config/chromium" 2>/dev/null
exit 0
