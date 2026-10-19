#!/usr/bin/env bash
# Enfileira N jobs para estressar o processor e ver o HPA escalar.
# Em outro terminal:  kubectl get hpa,pods -n hash-jobs -w
#   ./scripts/load-test.sh 200 5
set -euo pipefail
N=${1:-200}
ROUNDS=${2:-5}
URL=${URL:-http://localhost:8080}

echo "Enfileirando $N jobs (rounds=$ROUNDS) em $URL ..."
seq "$N" | xargs -P 20 -I{} curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST "$URL/jobs" -H 'content-type: application/json' \
  -d "{\"input\":\"job-{}\",\"rounds\":$ROUNDS}" | sort | uniq -c

echo
echo "Acompanhe:  watch -n2 'curl -s $URL/stats'"
