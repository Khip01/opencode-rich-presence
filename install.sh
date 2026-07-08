#!/usr/bin/env bash
# opencode-rich-presence installer
# One-line install for Linux, macOS, and Windows (Git Bash / MSYS2 /
# Cygwin / WSL). Pure PowerShell users should use the manual tarball
# install documented in docs/INSTALL.md.
#
# Usage:
#   # Install latest stable release:
#   curl -fsSL https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/install.sh | bash
#
#   # Pin to a specific version (skip the GitHub API lookup):
#   curl -fsSL https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/install.sh | ORP_VERSION=v3.1.6 bash
#
#   # If you do not have curl, replace it with wget -qO- <url> or fetch <url> manually and pipe to bash.
#
# What this script does:
#   1. Detects OS (linux, darwin, or Windows via Git Bash / MSYS / Cygwin / WSL).
#   2. Checks that Node.js 18+ and npm are on PATH.
#   3. Resolves a version (env ORP_VERSION or the latest stable tag via GitHub API).
#   4. Downloads the matching tarball from the GitHub Release.
#   5. Runs `npm install -g <tarball>` (sidesteps npm v11's broken git-dep symlinks).
#   6. Runs `opencode-rpc install` to set up the OpenCode plugin symlink.
#
# Why not `npm install -g <repo>#<tag>`? npm v11 has a bug installing
# global git deps: it creates a broken symlink under lib/node_modules
# and never creates the bin/ symlink. After npm cleans its cache temp
# dir (or after a reboot on some setups), the install vanishes with
# `zsh: command not found: opencode-rpc`. Tarball installs are
# unaffected. This script always installs from a tarball.

set -euo pipefail

REPO_OWNER="Khip01"
REPO_NAME="opencode-rich-presence"
REPO="${REPO_OWNER}/${REPO_NAME}"

# ---------- helpers ----------

log() {
  printf '[opencode-rich-presence installer] %s\n' "$*" >&2
}

err() {
  printf '[opencode-rich-presence installer] ERROR: %s\n' "$*" >&2
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

# On Windows, npm installs the bin shim as `<name>.cmd` for cmd.exe and
# `<name>` (a sh script) for Git Bash / MSYS. `command -v <name>` may
# or may not find the .cmd shim depending on the shell, so we check
# both forms explicitly.
have_opencode_rpc() {
  have_cmd opencode-rpc \
    || have_cmd opencode-rpc.cmd \
    || have_cmd opencode-rpc.exe
}

# ---------- 1. platform detection ----------

OS_RAW="$(uname -s 2>/dev/null || echo unknown)"
case "$OS_RAW" in
  Linux)  OS="linux" ;;
  Darwin) OS="darwin" ;;
  MINGW*) OS="windows-mingw" ;;  # Git Bash
  MSYS*)  OS="windows-msys" ;;   # MSYS2
  CYGWIN*) OS="windows-cygwin" ;; # Cygwin
  *)
    err "Unsupported OS: ${OS_RAW}."
    err "This installer runs in bash. On Windows, open Git Bash (or"
    err "MSYS2 / Cygwin / WSL) and retry. Pure cmd.exe / PowerShell"
    err "users should install from a tarball manually (see"
    err "docs/INSTALL.md)."
    exit 1
    ;;
esac
log "Detected OS: ${OS}"

# ---------- 2. tool checks ----------

if ! have_cmd node; then
  err "Node.js is not on PATH. Install Node.js 18+ first: https://nodejs.org/"
  exit 1
fi

if ! have_cmd npm; then
  err "npm is not on PATH. It ships with Node.js; reinstall Node.js to fix."
  exit 1
fi

if ! have_cmd curl && ! have_cmd wget; then
  err "Neither curl nor wget is on PATH. Install one of them and retry."
  exit 1
fi

NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  err "Node.js ${NODE_MAJOR}.x found, but 18+ is required."
  err "Update Node.js: https://nodejs.org/ or use nvm: nvm install 20"
  exit 1
fi
log "Node.js $(node --version), npm $(npm --version)"

fetch() {
  # fetch <url> <output_path>
  if have_cmd curl; then
    curl -fsSL -o "$2" "$1"
  else
    wget -q -O "$2" "$1"
  fi
}

fetch_text() {
  # fetch_text <url>
  if have_cmd curl; then
    curl -fsSL "$1"
  else
    wget -q -O - "$1"
  fi
}

# ---------- 3. resolve version ----------

VERSION="${ORP_VERSION:-}"

# Strip a leading "v" so users can pass either form. The rest of the
# script works with a bare semver string (e.g. "3.1.6") and
# re-adds the "v" only where the GitHub URL requires it.
VERSION="${VERSION#v}"

if [ -z "$VERSION" ]; then
  log "Resolving latest stable release from GitHub API..."
  RELEASE_JSON="$(fetch_text "https://api.github.com/repos/${REPO}/releases/latest" || true)"
  VERSION="$(printf '%s' "$RELEASE_JSON" \
    | grep -m1 '"tag_name"' \
    | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v?([^"]+)".*/\1/' \
    || true)"

  if [ -z "$VERSION" ]; then
    err "Could not determine the latest release via the GitHub API."
    err "Pin a version explicitly: ORP_VERSION=v3.1.6 bash install.sh"
    err "Or download a tarball manually from:"
    err "  https://github.com/${REPO}/releases/latest"
    exit 1
  fi
fi

log "Target version: v${VERSION}"

# ---------- 4. download tarball ----------

# The release.yml workflow renames `npm pack` output to
# `opencode-rich-presence-${{ github.ref_name }}.tgz`, and
# `github.ref_name` for a tag like `v3.1.6` is
# `v3.1.6` (the `v` is part of the ref). So the tarball
# filename on GitHub Releases is `opencode-rich-presence-v<version>.tgz`.
TAG="v${VERSION}"
TARBALL_NAME="opencode-rich-presence-${TAG}.tgz"
TARBALL_URL="https://github.com/${REPO}/releases/download/${TAG}/${TARBALL_NAME}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

TARBALL_PATH="${TMP_DIR}/${TARBALL_NAME}"

log "Downloading ${TARBALL_NAME}..."
if ! fetch "$TARBALL_URL" "$TARBALL_PATH"; then
  err "Download failed: ${TARBALL_URL}"
  err "Check that v${VERSION} has a published release at:"
  err "  https://github.com/${REPO}/releases/tag/v${VERSION}"
  exit 1
fi

# Quick sanity check: tarball must be a non-empty gzipped tar file.
if [ ! -s "$TARBALL_PATH" ]; then
  err "Downloaded file is empty: ${TARBALL_PATH}"
  exit 1
fi
if ! head -c 2 "$TARBALL_PATH" | grep -q $'\x1f\x8b'; then
  err "Downloaded file is not a gzip stream. The URL may be wrong."
  err "URL: ${TARBALL_URL}"
  exit 1
fi

# ---------- 5. npm install -g <tarball> ----------

log "Installing ${TARBALL_NAME} via npm..."
if ! npm install -g "$TARBALL_PATH"; then
  err "npm install failed."
  err "Try running it manually for more detail:"
  err "  npm install -g ${TARBALL_PATH}"
  exit 1
fi

# Confirm the binary landed on PATH. On Windows, npm writes both a
# .cmd shim (for cmd.exe) and a small sh wrapper (for Git Bash), so
# we check both forms. Some Windows PATHs do not include npm's
# %AppData%\npm prefix even after install; tell the user how to fix.
if ! have_opencode_rpc; then
  err "opencode-rpc was installed but is not on PATH."
  err "Your npm global prefix is: $(npm config get prefix)"
  case "$OS" in
    windows-*)
      err "On Windows, add that prefix to your user PATH (Settings >"
      err "System > Environment Variables) or run 'setx PATH \"%PATH%;$(npm config get prefix)\"'"
      err "from cmd.exe, then reopen your shell."
      ;;
    *)
      err "Make sure that prefix's bin/ subdirectory is on PATH."
      err "Quick fix: export PATH=\"\$(npm config get prefix)/bin:\$PATH\""
      ;;
  esac
  exit 1
fi
log "opencode-rpc $(opencode-rpc version 2>/dev/null || echo unknown)"

# ---------- 6. opencode-rpc install ----------

if ! have_cmd opencode; then
  log "OpenCode CLI not detected on PATH. Skipping plugin setup."
  log "After installing OpenCode, run: opencode-rpc install"
else
  log "Setting up OpenCode plugin symlink and config..."
  if ! opencode-rpc install; then
    err "opencode-rpc install failed."
    err "Run it manually after reviewing the error: opencode-rpc install"
    exit 1
  fi
fi

# ---------- 7. done ----------

cat <<EOF

opencode-rich-presence v${VERSION} installed.

Next steps:
  1. Restart OpenCode so the plugin symlink takes effect.
  2. Verify with: opencode-rpc info
  3. Tail the activity log: tail -f ~/.config/opencode/presence-activity.log

To upgrade later:
  opencode-rpc update                    # latest stable release
  opencode-rpc update --ref vX.Y.Z       # pin to a specific version

EOF
