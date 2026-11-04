# sess(): pick an omp/pi session anywhere, cd there, resume it.
# A child process cannot cd its parent shell, so the picker only prints
# '<cwd>\t<path>'; this function does the cd + exec.
# Usage: sess [initial-query]
sess() {
  local pick cwd path sesspick_bin=/home/dakai/Work/omp-sessions-plugin/sesspick
  [[ -x "$sesspick_bin" ]] || sesspick_bin="$(command -v sesspick 2>/dev/null)"
  pick="$("$sesspick_bin" --query "${1:-}")" || return
  path="${pick##*$'\t'}"
  cwd="${pick%$'\t'*}"
  cwd="${cwd##*$'\t'}"
  if [[ -n "$cwd" && -d "$cwd" ]]; then
    cd -- "$cwd" || return
  else
    echo "sess: original dir gone${cwd:+ ($cwd)}, staying in $PWD" >&2
  fi
  exec omp --resume "$path"
}
