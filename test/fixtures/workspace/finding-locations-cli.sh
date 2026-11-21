#!/bin/sh
# Synthetic ADR 0072 D5 output for locations/located.diagram.ts.
case "$1" in
  check)
    [ "$#" -eq 4 ] && [ "$2" = '--format' ] && [ "$3" = 'json' ] &&
      [ "${4##*/}" = 'located.diagram.ts' ] || exit 2
    cat <<'JSON'
{
  "errors": 1,
  "warnings": 1,
  "findings": [
    {
      "file": "located.diagram.ts", "line": 6, "column": 5,
      "rule": "overlap", "severity": "warn", "message": "部品が重なっている",
      "via": [{"line": 5, "column": 35}],
      "related": [{"file": "../parts.ts", "line": 4, "column": 40}]
    },
    {
      "file": "located.diagram.ts", "location": {"file": "../parts.ts", "line": 4, "column": 14},
      "rule": "build-error", "severity": "error", "message": "共通部品のエラー"
    }
  ]
}
JSON
    exit 1
    ;;
  build)
    [ "$#" -eq 5 ] && [ "${2##*/}" = 'located.diagram.ts' ] &&
      [ "$3" = '--out' ] && [ "$5" = '--no-lint' ] || exit 2
    printf '✗ %s: ../parts.ts:4:14: 共通部品のエラー\n' "$2" >&2
    exit 1
    ;;
  *) exit 2 ;;
esac
