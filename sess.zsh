# sess(): pick an omp/pi session anywhere, cd there, resume it.
# A child process cannot cd its parent shell, so the picker only prints
# '<cwd>\t<path>'; this function does the cd + exec.
# Usage: sess [initial-query]   # fuzzy-filter titles
#        sess -c <pattern>     # search session CONTENT (user+assistant text)
sess() {
  local pick cwd path sesspick_bin=/home/dakai/Work/omp-sessions-plugin/sesspick
  local -a args
  [[ -x "$sesspick_bin" ]] || sesspick_bin="$(command -v sesspick 2>/dev/null)"
  if [[ "${1:-}" == (-c|--content) ]]; then
    shift
    if (( $# == 0 )); then
      echo "usage: sess -c <pattern>" >&2
      return 2
    fi
    args=(--grep "$*")
  else
    args=(--query "${1:-}")
  fi
  pick="$("$sesspick_bin" "${args[@]}")" || return
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
