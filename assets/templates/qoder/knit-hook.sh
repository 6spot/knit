#!/bin/sh
for dir in /usr/local/bin /opt/homebrew/bin "$HOME/.local/bin" "$HOME/.volta/bin" "$HOME/.asdf/shims" "$HOME/.local/share/mise/shims"; do
  [ -d "$dir" ] && PATH="$dir:$PATH"
done
export PATH
if command -v knit >/dev/null 2>&1 && version=$(node -v 2>/dev/null); then
  major=${version#v}
  major=${major%%.*}
  if [ "$major" -ge 24 ] 2>/dev/null; then
    exec knit hook qoder "$1"
  fi
fi
exec "${SHELL:-/bin/zsh}" -lc 'exec knit hook qoder "$1"' sh "$1"
