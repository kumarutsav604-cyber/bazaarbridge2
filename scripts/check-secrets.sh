#!/usr/bin/env bash
# v7.1: AVNS_ + credential-URI patterns added; aivenv1 removed; exact-string
# allowlist for the two SAMPLE demo passwords and process.env references.
set -uo pipefail

# 1) Secret FILES must never be tracked. (.env.example is fine: ^\.env$ only
#    matches the exact name.)
if git ls-files | grep -Ei '\.(pem|key|cert|crt|p12|pfx)$|^\.env$|^certs/|^secrets/'; then
  echo "SECRET FILE TRACKED - abort"; exit 1
fi

# 2) Inline secrets. The URI rule catches scheme://user:pass@ for postgres,
#    postgresql, mysql, rediss, amqps, https, etc., regardless of password prefix.
PATTERNS="BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|AVNS_[A-Za-z0-9_-]{8,}|[a-z][a-z0-9+.-]*://[^/[:space:]@:]+:[^@[:space:]]+@|password[[:space:]]*[:=][[:space:]]*[\"']?[^[:space:]\"']{8,}"

# Allowlist: strip these EXACT literals, then re-test the residue. A line that
# mixes a demo string with a real secret still fails on what remains.
ALLOW="Demo@1234|Admin@1234|process\.env\.[A-Za-z_][A-Za-z0-9_]*"

hits=$(git grep -nIE "$PATTERNS" -- \
  ':!*.example' ':!docs/*' ':!scripts/check-secrets.sh' \
  | sed -E "s/($ALLOW)//g" \
  | grep -E "$PATTERNS" || true)

if [ -n "$hits" ]; then
  echo "$hits"
  echo "POSSIBLE INLINE SECRET - abort"; exit 1
fi

echo "secret scan clean"
