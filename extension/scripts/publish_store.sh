#!/bin/bash
# Upload + submit extension zip to Chrome Web Store and/or Edge Add-ons.
# Usage:
#   ./extension/scripts/publish_store.sh --ext info-highlight|semantic-highlight [--store chrome|edge|both] [zip]
set -euo pipefail

EXT=""
STORE=chrome
ZIP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ext) EXT="${2:?}"; shift 2 ;;
    --ext=*) EXT="${1#*=}"; shift ;;
    --store) STORE="${2:?}"; shift 2 ;;
    --store=*) STORE="${1#*=}"; shift ;;
    -h|--help)
      echo "Usage: $0 --ext info-highlight|semantic-highlight [--store chrome|edge|both] [zip]"
      exit 0
      ;;
    *)
      if [[ -z "$ZIP" ]]; then ZIP="$1"; shift; else echo "Unexpected: $1" >&2; exit 2; fi
      ;;
  esac
done

case "${EXT}" in
  info-highlight|semantic-highlight) ;;
  "") echo "Missing --ext info-highlight|semantic-highlight" >&2; exit 2 ;;
  *) echo "--ext must be info-highlight|semantic-highlight (got: $EXT)" >&2; exit 2 ;;
esac
case "$STORE" in
  chrome|edge|both) ;;
  *) echo "--store must be chrome|edge|both (got: $STORE)" >&2; exit 2 ;;
esac
if [[ "$STORE" != chrome && "$EXT" != info-highlight ]]; then
  echo "Edge Publish API is only wired for info-highlight (got --ext $EXT --store $STORE)." >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -z "${http_proxy:-}${https_proxy:-}${HTTP_PROXY:-}${HTTPS_PROXY:-}" ]]; then
  export http_proxy="${http_proxy:-http://127.0.0.1:7890}"
  export https_proxy="${https_proxy:-http://127.0.0.1:7890}"
fi

proxy="${https_proxy:-${HTTPS_PROXY:-${http_proxy:-${HTTP_PROXY:-}}}}"
curl_x=(curl -sS)
[[ -n "$proxy" ]] && curl_x=(curl -sS -x "$proxy")

version="$(python3 -c "import json; print(json.load(open('extension/${EXT}/manifest.json'))['version'])")"
if [[ -z "$ZIP" ]]; then
  if [[ "$EXT" == info-highlight ]]; then
    ZIP="extension/dist/info-highlight-v${version}.zip"
  else
    ZIP="extension/dist/info-lens-semantic-highlight-v${version}.zip"
  fi
fi
if [[ ! -f "$ZIP" ]]; then
  echo "Missing zip: $ZIP (run ./extension/${EXT}/pack.sh first)" >&2
  exit 1
fi

chrome_ext_id() {
  if [[ "$EXT" == info-highlight ]]; then
    echo "${CHROME_EXTENSION_ID_INFO_HIGHLIGHT:?missing CHROME_EXTENSION_ID_INFO_HIGHLIGHT in .env}"
  else
    echo "${CHROME_EXTENSION_ID_SEMANTIC_HIGHLIGHT:?missing CHROME_EXTENSION_ID_SEMANTIC_HIGHLIGHT in .env}"
  fi
}

publish_chrome() {
  : "${GOOGLE_CLIENT_ID:?missing GOOGLE_CLIENT_ID in .env}"
  : "${GOOGLE_CLIENT_SECRET:?missing GOOGLE_CLIENT_SECRET in .env}"
  : "${GOOGLE_REFRESH_TOKEN:?missing GOOGLE_REFRESH_TOKEN in .env}"
  : "${CHROME_PUBLISHER_ID:?missing CHROME_PUBLISHER_ID in .env}"
  local eid
  eid="$(chrome_ext_id)"

  echo "Chrome ($EXT): uploading $ZIP …"
  ACCESS="$("${curl_x[@]}" "https://oauth2.googleapis.com/token" \
    -d "client_secret=${GOOGLE_CLIENT_SECRET}&grant_type=refresh_token&refresh_token=${GOOGLE_REFRESH_TOKEN}&client_id=${GOOGLE_CLIENT_ID}" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')"

  "${curl_x[@]}" \
    -H "Authorization: Bearer ${ACCESS}" \
    -H "x-goog-api-version: 2" \
    -X POST -T "$ZIP" \
    "https://chromewebstore.googleapis.com/upload/v2/publishers/${CHROME_PUBLISHER_ID}/items/${eid}:upload"
  echo
  echo "Chrome ($EXT): publishing …"
  "${curl_x[@]}" \
    -H "Authorization: Bearer ${ACCESS}" \
    -H "x-goog-api-version: 2" \
    -H "Content-Type: application/json" \
    -X POST \
    "https://chromewebstore.googleapis.com/v2/publishers/${CHROME_PUBLISHER_ID}/items/${eid}:publish"
  echo
}

publish_edge() {
  : "${EDGE_CLIENT_ID:?missing EDGE_CLIENT_ID in .env}"
  : "${EDGE_API_KEY:?missing EDGE_API_KEY in .env}"
  : "${EDGE_PRODUCT_ID:?missing EDGE_PRODUCT_ID in .env}"

  local base="https://api.addons.microsoftedge.microsoft.com/v1/products/${EDGE_PRODUCT_ID}"
  echo "Edge ($EXT): uploading $ZIP …"
  local hdr
  hdr="$(mktemp)"
  "${curl_x[@]}" -D "$hdr" -o /tmp/edge-upload-body.txt -w "\nHTTP %{http_code}\n" \
    -H "Authorization: ApiKey ${EDGE_API_KEY}" \
    -H "X-ClientID: ${EDGE_CLIENT_ID}" \
    -H "Content-Type: application/zip" \
    -X POST -T "$ZIP" \
    "${base}/submissions/draft/package" || true
  echo "Edge upload body:"; cat /tmp/edge-upload-body.txt; echo
  local op
  op="$(python3 - "$hdr" <<'PY'
import sys,re
h=open(sys.argv[1],errors="ignore").read()
m=re.search(r"(?im)^Location:\s*(.+)$", h)
print((m.group(1).strip() if m else "").rstrip("/").split("/")[-1])
PY
)"
  if [[ -n "$op" ]]; then
    echo "Edge: upload operation $op — polling …"
    for _ in $(seq 1 30); do
      st="$("${curl_x[@]}" \
        -H "Authorization: ApiKey ${EDGE_API_KEY}" \
        -H "X-ClientID: ${EDGE_CLIENT_ID}" \
        "${base}/submissions/draft/package/operations/${op}")"
      echo "$st"
      echo "$st" | python3 -c 'import sys,json; d=json.load(sys.stdin); s=d.get("status") or d.get("Status"); raise SystemExit(0 if s in ("Succeeded","Success","Completed") else 1)' 2>/dev/null && break
      sleep 3
    done
  fi

  echo "Edge: submitting draft for review …"
  "${curl_x[@]}" \
    -H "Authorization: ApiKey ${EDGE_API_KEY}" \
    -H "X-ClientID: ${EDGE_CLIENT_ID}" \
    -H "Content-Type: application/json" \
    -X POST \
    -d '{"notes":"Package update via publish_store.sh"}' \
    "${base}/submissions"
  echo
}

case "$STORE" in
  chrome) publish_chrome ;;
  edge) publish_edge ;;
  both) publish_chrome; publish_edge ;;
esac
echo "Done (--ext $EXT --store $STORE)."
