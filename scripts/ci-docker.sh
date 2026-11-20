#!/usr/bin/env bash
set -euo pipefail

case "${1:?Usage: ci-docker.sh start|stop}" in
  start)
    : "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}" "${GITHUB_JOB:?}" "${GITHUB_ENV:?}"
    daemon_name="relay-ci-docker-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${GITHUB_JOB}"
    echo "CI_DOCKER_CONTAINER=$daemon_name" >> "$GITHUB_ENV"
    # The runner is a container. Its network namespace keeps nested services'
    # localhost ports reachable by the test processes, with a private daemon.
    sudo -n docker --host unix:///var/run/docker.sock run --detach --rm --privileged \
      --name "$daemon_name" --memory 2g --memory-swap 3g \
      --network "container:$(hostname)" --pid "container:$(hostname)" \
      docker:29.1.3-dind dockerd --host=tcp://127.0.0.1:23750 --tls=false
    for attempt in $(seq 1 60); do
      if docker --host tcp://127.0.0.1:23750 info >/dev/null 2>&1; then
        echo "DOCKER_HOST=tcp://127.0.0.1:23750" >> "$GITHUB_ENV"
        exit 0
      fi
      sleep 1
    done
    sudo -n docker --host unix:///var/run/docker.sock logs "$daemon_name"
    exit 1
    ;;
  stop)
    sudo -n docker --host unix:///var/run/docker.sock rm --force --volumes "${CI_DOCKER_CONTAINER:?}"
    ;;
  *) echo 'Usage: ci-docker.sh start|stop' >&2; exit 2 ;;
esac
