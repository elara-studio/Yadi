#!/bin/sh
# Generates speech fixtures for the audio and speech-recognition tests (macOS only).
# Uses the built-in `say` voice and `afconvert`; output is 16 kHz mono 16-bit WAV plus a .txt
# with the exact reference sentence. Files go to scripts/fixtures/ and are gitignored.
set -eu

if [ "$(uname)" != "Darwin" ]; then
  echo "gen-fixtures.sh needs macOS (say, afconvert)." >&2
  exit 1
fi

DIR="$(cd "$(dirname "$0")" && pwd)/fixtures"
mkdir -p "$DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

make_fixture() {
  name="$1"
  text="$2"
  say -o "$TMP/$name.aiff" "$text"
  afconvert -f WAVE -d LEI16@16000 -c 1 "$TMP/$name.aiff" "$DIR/$name.wav"
  printf '%s\n' "$text" > "$DIR/$name.txt"
  echo "created $DIR/$name.wav"
}

make_fixture sentence-1 "write a short email to my manager asking for friday off"
make_fixture sentence-2 "the login screen crashes when I rotate the phone"
make_fixture sentence-3 "explain how a binary search tree works in simple words"
make_fixture sentence-4 "add a Hilt module to the Kotlin project"
