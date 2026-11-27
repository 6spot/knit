#!/bin/sh
for dir in "$HOME/.local/bin" "${VOLTA_HOME:-$HOME/.volta}/bin" \
    "${ASDF_DATA_DIR:-$HOME/.asdf}/shims" "${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims" \
    "${FNM_MULTISHELL_PATH:+$FNM_MULTISHELL_PATH/bin}" "${FNM_DIR:-$HOME/.local/share/fnm}/aliases/default/bin" \
    "$HOME/Library/Application Support/fnm/aliases/default/bin" /opt/homebrew/bin /usr/local/bin; do
  [ -d "$dir" ] && PATH="${PATH:+$PATH:}$dir"
done
export PATH
if command -v knit >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  KNIT_HOOK_TRY_PATH=1 knit hook qoder "$1"
  status=$?
  [ "$status" -eq 78 ] || exit "$status"
fi
case ${SHELL:-} in
  */sh|*/bash|*/zsh|*/ksh) login_shell=$SHELL ;;
  *) login_shell=/bin/sh ;;
esac
[ -x "$login_shell" ] || login_shell=/bin/sh
exec "$login_shell" -lc 'exec knit hook qoder "$1"' sh "$1"
