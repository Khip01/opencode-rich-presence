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
  --dev [BRANCH]  Install latest commit on BRANCH (default: main).
                   IMPORTANT: --dev defaults to the upstream \`main\` branch,
                   which is currently v2.1.1 (pre-redesign). If you are
                   on v3 (e.g. redesign/v3-daemon), you MUST pass the
                   branch explicitly or you will be downgraded to v2.x:
                     opencode-rpc update --dev redesign/v3-daemon
  --stable         Force install latest stable tag (use to switch off dev)
  --ref REF        Install a specific git ref: tag, branch, or commit SHA.
                   Use this for pre-release branches (e.g. redesign/v3-daemon)
                   instead of \`npm install -g <url>#<branch>\`, which hits
                   a npm v11 bug that installs the package without bin
                   symlinks (the opencode-rpc command would be missing).
                    Examples:
                      opencode-rpc update --ref redesign/v3-daemon
                      opencode-rpc update --ref v3.1.5
                      opencode-rpc update --ref 6664bfb
                      opencode-rpc update --ref 471ce940ba316180fa08617dcb04ee1b59599e7f
  --repo OWNER/REPO  Install from a fork instead of the upstream repo.
                     Use this to test changes in your own fork before
                     opening a PR:
                       opencode-rpc update --repo myname/opencode-rich-presence --ref my-branch
                       opencode-rpc update --repo myname/opencode-rich-presence --dev my-branch

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

  # Install from your own fork:
  opencode-rpc update --repo myname/opencode-rich-presence --ref my-branch
  opencode-rpc install

Update:
  opencode-rpc update                  # latest stable release tag
  opencode-rpc update --stable         # force install latest stable tag
  opencode-rpc update --dev            # latest commit on main (developer)
  opencode-rpc update --dev <branch>   # latest commit on <branch> (developer)
  opencode-rpc update --ref REF        # install specific ref (branch/tag/SHA)
  opencode-rpc update --repo OWNER/REPO  # install from a fork (combine with above)

Documentation: https://github.com/Khip01/opencode-rich-presence
`;

export async function help() {
    console.log(USAGE);
}
