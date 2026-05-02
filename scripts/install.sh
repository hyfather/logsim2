#!/bin/sh
# logsim installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/hyfather/logsim2/main/scripts/install.sh | sh
#
# Environment variables:
#   LOGSIM_VERSION   Tag to install (default: latest release).
#   LOGSIM_PREFIX    Install prefix; binary lands in $LOGSIM_PREFIX/bin/logsim.
#                    Default: /usr/local if writable, else $HOME/.local.
#   LOGSIM_REPO      GitHub repo slug (default: hyfather/logsim2).

set -eu

REPO="${LOGSIM_REPO:-hyfather/logsim2}"
VERSION="${LOGSIM_VERSION:-latest}"

log() { printf 'logsim-install: %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"
}

need uname
need tar
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
  fetch_stdout() { curl -fsSL "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
  fetch_stdout() { wget -qO- "$1"; }
else
  die "need either curl or wget"
fi

uname_s=$(uname -s)
case "$uname_s" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) die "unsupported OS: $uname_s (only linux and darwin builds are published)" ;;
esac

uname_m=$(uname -m)
case "$uname_m" in
  x86_64|amd64) arch=amd64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) die "unsupported arch: $uname_m" ;;
esac

if [ "$VERSION" = "latest" ]; then
  log "resolving latest release tag…"
  tag=$(fetch_stdout "https://api.github.com/repos/${REPO}/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' \
    | head -n1)
  [ -n "$tag" ] || die "could not resolve latest release; set LOGSIM_VERSION=vX.Y.Z"
else
  tag="$VERSION"
fi

asset="logsim-${os}-${arch}.tar.gz"
url="https://github.com/${REPO}/releases/download/${tag}/${asset}"

if [ -n "${LOGSIM_PREFIX:-}" ]; then
  prefix="$LOGSIM_PREFIX"
elif [ -w /usr/local/bin ] 2>/dev/null; then
  prefix=/usr/local
else
  prefix="$HOME/.local"
fi
bindir="$prefix/bin"
mkdir -p "$bindir"

tmpdir=$(mktemp -d 2>/dev/null || mktemp -d -t logsim)
trap 'rm -rf "$tmpdir"' EXIT INT TERM

log "downloading $asset ($tag)…"
fetch "$url" "$tmpdir/$asset" || die "download failed: $url"

# Best-effort checksum verification — skipped if shasum unavailable.
if command -v shasum >/dev/null 2>&1; then
  if fetch "${url}.sha256" "$tmpdir/${asset}.sha256" 2>/dev/null; then
    (cd "$tmpdir" && shasum -a 256 -c "${asset}.sha256" >/dev/null) \
      || die "checksum mismatch for $asset"
    log "checksum ok"
  fi
fi

tar -xzf "$tmpdir/$asset" -C "$tmpdir"
src="$tmpdir/logsim-${os}-${arch}"
[ -f "$src" ] || die "archive layout unexpected: missing $src"

install -m 0755 "$src" "$bindir/logsim" 2>/dev/null \
  || { cp "$src" "$bindir/logsim" && chmod 0755 "$bindir/logsim"; }

log "installed $bindir/logsim ($tag)"

case ":$PATH:" in
  *":$bindir:"*) ;;
  *)
    log "note: $bindir is not on your PATH."
    log "      add it with:  export PATH=\"$bindir:\$PATH\""
    ;;
esac

"$bindir/logsim" --help >/dev/null 2>&1 || log "warning: 'logsim --help' did not run cleanly"
