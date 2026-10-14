#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  exec sudo "$0" "$@"
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"
DOCKER_KEYRING="/etc/apt/keyrings/docker.asc"
DOCKER_SOURCE="/etc/apt/sources.list.d/docker.sources"

apt-get update
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "${DOCKER_KEYRING}"
chmod a+r "${DOCKER_KEYRING}"

ARCHITECTURE="$(dpkg --print-architecture)"
. /etc/os-release
RELEASE_CODENAME="${UBUNTU_CODENAME:-${VERSION_CODENAME}}"

printf '%s\n' \
  'Types: deb' \
  'URIs: https://download.docker.com/linux/ubuntu' \
  "Suites: ${RELEASE_CODENAME}" \
  'Components: stable' \
  "Architectures: ${ARCHITECTURE}" \
  "Signed-By: ${DOCKER_KEYRING}" \
  > "${DOCKER_SOURCE}"

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

if ! docker info >/dev/null 2>&1; then
  if command -v systemctl >/dev/null 2>&1 && systemctl start docker >/dev/null 2>&1; then
    :
  else
    nohup dockerd > /tmp/wortschatzberg-dockerd.log 2>&1 &
  fi
fi

for _ in $(seq 1 30); do
  docker info >/dev/null 2>&1 && break
  sleep 1
done

docker info >/dev/null
docker compose --project-name wortschatzberg --file "${COMPOSE_FILE}" up -d --build
docker compose --project-name wortschatzberg --file "${COMPOSE_FILE}" ps

printf '\nWortschatzberg is available at http://127.0.0.1:8000\n'
