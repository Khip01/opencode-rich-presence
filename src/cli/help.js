const USAGE = `
opencode-rich-presence - Discord Rich Presence plugin for OpenCode AI

Usage:
  rich-presence <command> [options]

Commands:
  install      Set up Rich Presence for OpenCode (creates config)
  uninstall    Remove Rich Presence configuration
  restart      Restart Discord desktop client
  update       Check for updates and upgrade
  info         Show diagnostic information
  help         Show this message
  version      Print version

Installation (one-time):
  npm install -g https://github.com/Khip01/opencode-rich-presence/releases/latest/download/opencode-rich-presence-latest.tgz
  rich-presence install
  # Then add "plugin": ["opencode-rich-presence"] to ~/.config/opencode/opencode.json

Update:
  rich-presence update

Documentation: https://github.com/Khip01/opencode-rich-presence
`;

export async function help() {
    console.log(USAGE);
}
