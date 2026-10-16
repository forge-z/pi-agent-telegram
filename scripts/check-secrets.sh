#!/usr/bin/env bash
set -euo pipefail

image='ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f'

if ! command -v docker >/dev/null 2>&1; then
  echo 'Docker is required to run the pinned Gitleaks scanner.' >&2
  exit 2
fi

repo_root="$(git rev-parse --show-toplevel)"
git_dir="$(git rev-parse --absolute-git-dir)"
common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
mounts=(--mount "type=bind,source=${repo_root},target=${repo_root},readonly")

# Worktrees keep their gitdir outside the checkout. Mount those paths read-only
# at the same absolute paths so the .git pointer remains valid in the container.
if [[ "$git_dir" != "$repo_root/.git" ]]; then
  mounts+=(--mount "type=bind,source=${git_dir},target=${git_dir},readonly")
fi
if [[ "$common_dir" != "$repo_root/.git" && "$common_dir" != "$git_dir" ]]; then
  mounts+=(--mount "type=bind,source=${common_dir},target=${common_dir},readonly")
fi

docker run --rm "${mounts[@]}" --workdir "$repo_root" "$image" \
  git "$repo_root" \
  --config="$repo_root/.gitleaks.toml" \
  --log-opts=HEAD \
  --no-banner \
  --redact=100
