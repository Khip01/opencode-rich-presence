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
  --dev        Install latest commit from main branch (developer)

Installation (one-time):
  # Stable release (replace v2.1.0 with the version you want):
  npm install -g Khip01/opencode-rich-presence#v2.1.0
  opencode-rpc install

  # Dev / bleeding-edge (latest commit on main):
  npm install -g Khip01/opencode-rich-presence
  opencode-rpc install

Update:
  opencode-rpc update                  # latest stable release tag
  opencode-rpc update --dev            # latest commit on main (developer)

Documentation: https://github.com/Khip01/opencode-rich-presence
`;

export async function help() {
    console.log(USAGE);
}
