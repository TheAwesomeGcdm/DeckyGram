#!/usr/bin/env bash
CLI_LOCATION="$(pwd)/cli"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/backend/out/deckygram-telegram-web" || exit 1
cp -a "$ROOT/electron/telegram-web/." "$ROOT/backend/out/deckygram-telegram-web/" || exit 1
echo "Building plugin in $(pwd)"
printf "Please input sudo password to proceed.\n"

# read -s sudopass

# printf "\n"

echo $sudopass | sudo -E $CLI_LOCATION/decky plugin build $(pwd)
