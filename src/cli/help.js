const USAGE = `
opencode-rich-presence - Discord Rich Presence plugin for OpenCode AI

Usage:
  opencode-rpc <command> [options]

Commands:
  install      Set up Rich Presence for OpenCode (creates config)
  uninstall    Remove Rich Presence configuration
  restart      Reload the plugin worker (writes restart signal, kills worker)
  update       Check for updates and upgrade
  info         Show diagnostic information
  help         Show this message
  version      Print version

Options (update):
  --prerelease, --pre    Include prerelease versions when checking for updates

Installation (one-time):
  npm install -g https://github.com/Khip01/opencode-rich-presence/releases/latest/download/opencode-rich-presence-latest.tgz
  opencode-rpc install
  # The installer creates a symlink at ~/.config/opencode/plugins/opencode-rich-presence.js
  # that OpenCode auto-loads. No need to edit opencode.jsonc.

Update:
  opencode-rpc update                  # stable releases only
  opencode-rpc update --prerelease     # include prerelease builds

Documentation: https://github.com/Khip01/opencode-rich-presence
`;

export async function help() {
    console.log(USAGE);
}
