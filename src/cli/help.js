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
  --stable     Force install latest stable tag (use to switch off dev)
  --ref REF    Install a specific git ref: tag, branch, or commit SHA.
               Use this for pre-release branches (e.g. redesign/v3-daemon)
               instead of \`npm install -g <url>#<branch>\`, which hits
               a npm v11 bug that installs the package without bin
               symlinks (the opencode-rpc command would be missing).
               Examples:
                 opencode-rpc update --ref redesign/v3-daemon
                 opencode-rpc update --ref v3.0.4-phase2
                 opencode-rpc update --ref 6664bfb

Installation (one-time):
  # Stable release (recommended for normal use):
  opencode-rpc update                  # latest stable tag, OR
  npm install -g Khip01/opencode-rich-presence  # default branch tip
  opencode-rpc install

  # Dev branch (e.g. redesign/v3-daemon). DO NOT use the form below,
  # it triggers npm v11's broken-symlink bug for git deps with #ref:
  #   npm install -g Khip01/opencode-rich-presence#redesign/v3-daemon
  # Use this instead:
  opencode-rpc update --ref redesign/v3-daemon
  opencode-rpc install

Update:
  opencode-rpc update                  # latest stable release tag
  opencode-rpc update --stable         # force install latest stable tag
  opencode-rpc update --dev            # latest commit on main (developer)
  opencode-rpc update --ref REF        # install specific ref (branch/tag/SHA)

Documentation: https://github.com/Khip01/opencode-rich-presence
`;

export async function help() {
    console.log(USAGE);
}
