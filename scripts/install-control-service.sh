#!/bin/sh
set -eu

usage() {
  cat >&2 <<'EOF'
usage: install-control-service.sh ROOT_OWNED_CANDIDATE EXPECTED_MANIFEST_SHA256

The candidate must be a frozen, root-owned directory containing exactly:
  SHA256SUMS
  jeverb_control_service.py
  jeverb-control.service
  org.jeverb.control.policy
  verify_installed.py

EXPECTED_MANIFEST_SHA256 must be reviewed out-of-band from this checkout.
Create and qualify the candidate before invoking this installer; this script
never reads privileged payload files from the development checkout.
EOF
  exit 2
}

[ "$#" -eq 2 ] || usage
[ "$(id -u)" -eq 0 ] || {
  echo "install-control-service: run through an explicit root/operator install" >&2
  exit 1
}

CANDIDATE=$1
EXPECTED_MANIFEST_SHA256=$2
case "$EXPECTED_MANIFEST_SHA256" in
  *[!0-9a-f]*|'') echo "install-control-service: expected manifest digest must be 64 lowercase hex characters" >&2; exit 1 ;;
esac
[ "${#EXPECTED_MANIFEST_SHA256}" -eq 64 ] || {
  echo "install-control-service: expected manifest digest must be 64 lowercase hex characters" >&2
  exit 1
}

# Reject symlinks in the candidate path and require every directory component
# to be root-owned and not writable by group/other. The artifact is therefore
# immutable to the unprivileged checkout owner while it is verified and copied.
case "$CANDIDATE" in
  /*) ;;
  *) echo "install-control-service: candidate path must be absolute" >&2; exit 1 ;;
esac
OLD_IFS=$IFS
IFS=/
set -f
set -- $CANDIDATE
set +f
IFS=$OLD_IFS
PATH_PART=
for COMPONENT do
  [ -n "$COMPONENT" ] || continue
  PATH_PART="$PATH_PART/$COMPONENT"
  [ ! -L "$PATH_PART" ] || { echo "install-control-service: symlink in candidate path" >&2; exit 1; }
  [ -d "$PATH_PART" ] || { echo "install-control-service: candidate path component is not a directory" >&2; exit 1; }
  OWNER=$(stat -c '%u' "$PATH_PART")
  MODE=$(stat -c '%a' "$PATH_PART")
  [ "$OWNER" = 0 ] || { echo "install-control-service: candidate path is not root-owned" >&2; exit 1; }
  # A directory mode with group/other write permission is not a frozen input.
  MODE_VALUE=$(printf '%d' "0$MODE")
  [ $((MODE_VALUE & 0022)) -eq 0 ] || { echo "install-control-service: candidate path is writable by group/other" >&2; exit 1; }
done

[ -d "$CANDIDATE" ] || { echo "install-control-service: candidate directory not found" >&2; exit 1; }
EXPECTED_FILES='SHA256SUMS
jeverb_control_service.py
jeverb-control.service
org.jeverb.control.policy
verify_installed.py'
ACTUAL_FILES=$(find "$CANDIDATE" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)
[ "$ACTUAL_FILES" = "$(printf '%s\n' "$EXPECTED_FILES" | LC_ALL=C sort)" ] || {
  echo "install-control-service: candidate must contain exactly the five required files" >&2
  exit 1
}

for FILE in SHA256SUMS jeverb_control_service.py jeverb-control.service org.jeverb.control.policy verify_installed.py; do
  [ -f "$CANDIDATE/$FILE" ] && [ ! -L "$CANDIDATE/$FILE" ] || {
    echo "install-control-service: candidate entry is not a regular file: $FILE" >&2
    exit 1
  }
  OWNER=$(stat -c '%u' "$CANDIDATE/$FILE")
  MODE=$(stat -c '%a' "$CANDIDATE/$FILE")
  [ "$OWNER" = 0 ] || { echo "install-control-service: candidate file is not root-owned: $FILE" >&2; exit 1; }
  MODE_VALUE=$(printf '%d' "0$MODE")
  [ $((MODE_VALUE & 0022)) -eq 0 ] || { echo "install-control-service: candidate file is writable by group/other: $FILE" >&2; exit 1; }
done

MANIFEST_DIGEST=$(sha256sum "$CANDIDATE/SHA256SUMS" | awk '{print $1}')
[ "$MANIFEST_DIGEST" = "$EXPECTED_MANIFEST_SHA256" ] || {
  echo "install-control-service: candidate manifest digest does not match reviewed digest" >&2
  exit 1
}

EXPECTED_ENTRIES='jeverb_control_service.py
jeverb-control.service
org.jeverb.control.policy
verify_installed.py'
MANIFEST_ENTRIES=$(awk 'NF { if (NF != 2 || length($1) != 64 || $1 ~ /[^0-9a-f]/ || $2 !~ /^\*?(jeverb_control_service\.py|jeverb-control\.service|org\.jeverb\.control\.policy|verify_installed\.py)$/) { bad=1; next } print $2 } END { if (bad) exit 1 }' "$CANDIDATE/SHA256SUMS") || {
  echo "install-control-service: malformed candidate manifest" >&2
  exit 1
}
MANIFEST_ENTRIES=$(printf '%s\n' "$MANIFEST_ENTRIES" | sed 's/^\*//' | LC_ALL=C sort)
[ "$MANIFEST_ENTRIES" = "$(printf '%s\n' "$EXPECTED_ENTRIES" | LC_ALL=C sort)" ] || {
  echo "install-control-service: manifest must cover each required payload exactly once" >&2
  exit 1
}
(cd "$CANDIDATE" && sha256sum --check --status SHA256SUMS) || {
  echo "install-control-service: candidate payload hash verification failed" >&2
  exit 1
}

# Snapshot all verified inputs into a new root-owned, private staging directory.
# Destinations are populated only from this snapshot, and the staged bytes are
# checked again to close the verification-to-copy gap.
STAGE_PARENT=/var/lib/jeverb/install-staging
install -d -o root -g root -m 0700 /var/lib/jeverb "$STAGE_PARENT"
STAGE="$STAGE_PARENT/$EXPECTED_MANIFEST_SHA256"
mkdir -m 0700 "$STAGE" || {
  echo "install-control-service: staging candidate already exists; refusing reuse" >&2
  exit 1
}
cp "$CANDIDATE/SHA256SUMS" "$STAGE/SHA256SUMS"
cp "$CANDIDATE/jeverb_control_service.py" "$STAGE/jeverb_control_service.py"
cp "$CANDIDATE/jeverb-control.service" "$STAGE/jeverb-control.service"
cp "$CANDIDATE/org.jeverb.control.policy" "$STAGE/org.jeverb.control.policy"
cp "$CANDIDATE/verify_installed.py" "$STAGE/verify_installed.py"
chown root:root "$STAGE" "$STAGE"/*
chmod 0700 "$STAGE"
chmod 0444 "$STAGE"/*
[ "$(sha256sum "$STAGE/SHA256SUMS" | awk '{print $1}')" = "$EXPECTED_MANIFEST_SHA256" ] || {
  echo "install-control-service: staged manifest digest changed" >&2
  exit 1
}
(cd "$STAGE" && sha256sum --check --status SHA256SUMS) || {
  echo "install-control-service: staged payload verification failed" >&2
  exit 1
}

install -d -o root -g root -m 0755 /usr/lib/jeverb/control-service
install -o root -g root -m 0644 "$STAGE/jeverb_control_service.py" /usr/lib/jeverb/control-service/jeverb_control_service.py
install -d -o root -g root -m 0755 /usr/share/polkit-1/actions
install -o root -g root -m 0644 "$STAGE/org.jeverb.control.policy" /usr/share/polkit-1/actions/org.jeverb.control.policy
install -d -o root -g root -m 0755 /etc/systemd/system
install -o root -g root -m 0644 "$STAGE/jeverb-control.service" /etc/systemd/system/jeverb-control.service

# Verify installed destinations with the verifier from the hash-checked stage.
# A failed comparison aborts before asking systemd to load or start the service.
python3 "$STAGE/verify_installed.py" "$STAGE" /

systemctl daemon-reload
systemctl enable --now jeverb-control.service

echo "Installed verified jeverb-control candidate $EXPECTED_MANIFEST_SHA256. Initial state is OFF; use jev-control status/on/off."
