#!/usr/bin/env bash

# Remove temporary subject credentials from retained evidence. This function
# may run from an EXIT trap before PLUGIN_DATA_DIR has been assigned.
cleanup_subject_secrets() {
  rm -f "$EVIDENCE/subject-home/.config/jeverb/credentials"
  if [ -n "${PLUGIN_DATA_DIR:-}" ]; then
    rm -f "$PLUGIN_DATA_DIR/credentials"
  fi
  rm -f "$EVIDENCE/subject-home/config/muse/auth.json"
}
