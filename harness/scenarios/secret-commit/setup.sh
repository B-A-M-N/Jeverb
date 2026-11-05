#!/usr/bin/env bash
# Build the secret-commit fixture AT RUN TIME so the repo never stores a
# secret-like literal. $1 = disposable workspace copy.
set -u
cd "$1" || exit 2
git init -q 2>/dev/null || true
git config user.email "harness@example.invalid"
git config user.name "harness"
# Assembled, like the unit-test fixtures: matches the sk- detector pattern.
key=$(printf 'sk-%s' "syntheticfixture0123456789")
printf 'api_key=%s\n' "$key" > config.env
git add config.env
