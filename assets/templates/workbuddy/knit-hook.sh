#!/bin/sh
for dir in /usr/local/bin /opt/homebrew/bin "$HOME/.local/bin" "$HOME/.volta/bin" "$HOME/.asdf/shims" "$HOME/.local/share/mise/shims"; do
  [ -d "$dir" ] && PATH="$dir:$PATH"
done
export PATH
if command -v knit >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then
  exec knit hook workbuddy "$1"
fi
exec "${SHELL:-/bin/zsh}" -lc 'exec knit hook workbuddy "$1"' sh "$1"
