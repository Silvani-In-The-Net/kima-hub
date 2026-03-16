#!/usr/bin/env bash
# Create the E2E test user inside a running Kima Docker container.
# Usage: bash scripts/create-e2e-user.sh [container-name]
#
# Reads KIMA_TEST_USERNAME and KIMA_TEST_PASSWORD from env, or uses defaults.
#
# Defaults (change via env):
#   KIMA_TEST_USERNAME=kima_e2e
#   KIMA_TEST_PASSWORD=KimaE2ETest2026!
#   KIMA_CONTAINER=kima-test

set -euo pipefail

CONTAINER="${KIMA_CONTAINER:-kima-test}"
TEST_USER="${KIMA_TEST_USERNAME:-kima_e2e}"
TEST_PASS="${KIMA_TEST_PASSWORD:-KimaE2ETest2026!}"

echo "[e2e setup] Creating test user '${TEST_USER}' in container '${CONTAINER}'..."

# Generate bcrypt hash inside the container where bcrypt is installed.
# Pass the password via -e so Docker sets it as an env var -- avoids shell
# quoting and expansion issues with special characters in the password.
HASH=$(docker exec -e "TEST_PASS=${TEST_PASS}" "${CONTAINER}" bash -c '
  cd /app/backend && node -e "
    const b = require(\"bcrypt\");
    b.hash(process.env.TEST_PASS, 10).then(h => process.stdout.write(h));
  "
')

# Write SQL to a temp file inside the container to avoid dollar sign expansion.
# The bcrypt hash contains $2b$10$... which bash would mangle if embedded in
# a double-quoted string passed to docker exec.
docker exec -e "HASH=${HASH}" -e "TEST_USER=${TEST_USER}" "${CONTAINER}" bash -c '
  # Heredoc is unquoted so ${TEST_USER} and ${HASH} expand (env vars set via -e above).
  # SQL single quotes are plain literals here -- no shell escaping needed.
  psql -U kima -d kima <<ENDSQL
INSERT INTO "User" (id, username, "passwordHash", role, "onboardingComplete")
VALUES ('\''e2e_test_user_kima'\'', '\''${TEST_USER}'\'', '\''${HASH}'\'', '\''admin'\'', true)
ON CONFLICT (username) DO UPDATE
  SET "passwordHash" = EXCLUDED."passwordHash",
      role = EXCLUDED.role;
INSERT INTO "UserSettings" ("userId", "playbackQuality", "wifiOnly", "offlineEnabled", "maxCacheSizeMb")
VALUES ('\''e2e_test_user_kima'\'', '\''original'\'', false, false, 10240)
ON CONFLICT ("userId") DO NOTHING;
ENDSQL
'

echo "[e2e setup] Test user '${TEST_USER}' ready."
echo ""
echo "Set these env vars before running Playwright:"
echo "  export KIMA_TEST_USERNAME=${TEST_USER}"
echo "  export KIMA_TEST_PASSWORD=${TEST_PASS}"
