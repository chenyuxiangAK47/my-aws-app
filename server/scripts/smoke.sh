#!/usr/bin/env bash
set -euo pipefail

API="${API:-http://127.0.0.1:3000}"

echo "1) /api/health"
curl -fsS "$API/api/health" | jq .

echo "2) dev login -> TOKEN"
TOKEN=$(curl -fsS -X POST "$API/api/dev/login" \
  -H 'Content-Type: application/json' \
  -d '{"uid":"smoke","role":"admin"}' | jq -r .token)
echo "TOKEN=${TOKEN:0:16}..."

echo "3) submit"
curl -fsS -X POST "$API/api/submit" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"text":"smoke test"}' | jq .

echo "4) history page=1&pageSize=3"
curl -fsS "$API/api/history?page=1&pageSize=3" | jq .

echo "5) fs read/write"
curl -fsS -X POST "$API/api/fs-test" -H 'Content-Type: application/json' \
  -d '{"file":"smoke.txt","content":"hi"}' | jq .
curl -fsS "$API/api/fs-test?file=smoke.txt" | jq .

echo "6) admin delete local history"
curl -fsS -X DELETE "$API/api/history" -H "Authorization: Bearer $TOKEN" | jq .

echo "OK ✅"
