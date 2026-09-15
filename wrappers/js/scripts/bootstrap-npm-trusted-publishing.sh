#!/usr/bin/env bash
# One-time bootstrap for npm trusted publishing (OIDC).
#
# npm only lets you configure a trusted publisher for a package that already exists in the
# registry. This script publishes a minimal 0.0.0-oidc-bootstrap.0 placeholder for any package name
# released by this repository that does not exist yet. Existing package names are skipped, so it is
# safe to reuse when a new platform package is added.
#
# Run locally, logged in to npm (`npm login`) as an account with publish rights to the @bloxbean
# scope. Publishing is irreversible and may prompt for 2FA, so the script asks for confirmation
# before each missing package is created.
#
# Afterwards, configure the trusted publisher for each package printed by this script:
#   Package -> Settings -> Trusted Publisher -> GitHub Actions
#     Organization or user: bloxbean
#     Repository:           cardano-client-bindings
#     Workflow filename:    publish-js.yml
#     Environment:          release
#     Allowed action:       npm publish
#
# CLI alternative (requires npm >= 11.15 and account-level 2FA):
#   npm trust github <package> --repo bloxbean/mesmo \
#     --file publish-js.yml --environment release --allow-publish
#
# See wrappers/js/scripts/README.md for the complete operator checklist and
# .github/workflows/publish-js.yml for the release flow.
set -euo pipefail

VERSION="0.0.0-oidc-bootstrap.0"
PACKAGES=(
  "@bloxbean/mesmo"
  "@bloxbean/mesmo-linux-x86_64"
  "@bloxbean/mesmo-linux-aarch64"
  "@bloxbean/mesmo-linux-musl-x86_64"
  "@bloxbean/mesmo-macos-aarch64"
  "@bloxbean/mesmo-windows-x86_64"
)

npm_user="$(npm whoami 2>/dev/null)" || {
  echo "Not logged in to npm. Run: npm login" >&2
  exit 1
}
echo "Publishing as: ${npm_user}"

workdir="$(mktemp -d)"
trap 'rm -rf -- "$workdir"' EXIT

published=()
for name in "${PACKAGES[@]}"; do
  if npm view "$name" name --json >/dev/null 2>&1; then
    echo "Skipping ${name}: package already exists."
    continue
  fi

  echo
  echo "${name} does not exist in the npm registry."
  read -r -p "Publish ${name}@${VERSION} as a public bootstrap package? [y/N] " answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *)
      echo "Not published."
      continue
      ;;
  esac

  dir="$workdir/${name##*/}"
  mkdir -p "$dir"
  cat > "$dir/package.json" <<JSON
{
  "name": "${name}",
  "version": "${VERSION}",
  "description": "Placeholder published once to enable npm trusted publishing for this package name. Do not install; real releases are published by CI from https://github.com/bloxbean/mesmo.",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/bloxbean/mesmo.git"
  }
}
JSON
  printf 'Placeholder for the one-time npm trusted-publishing bootstrap of %s. Do not install.\n' \
    "$name" > "$dir/README.md"

  echo "Publishing ${name}@${VERSION} ..."
  npm publish "$dir" --access public --tag preview
  published+=("$name")
done

echo
if ((${#published[@]} == 0)); then
  echo "No bootstrap packages were published."
  exit 0
fi

echo "Bootstrap publishing complete. Configure trusted publishing for:"
printf '  %s\n' "${published[@]}"
echo
echo "Use the npmjs.com settings shown at the top of this script, or npm >= 11.15:"
for name in "${published[@]}"; do
  printf 'npm trust github %q --repo bloxbean/mesmo --file publish-js.yml --environment release --allow-publish\n' \
    "$name"
done
