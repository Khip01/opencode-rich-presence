import { bold, cyan, dim, green, yellow } from "./colors.js";

function section(title) {
    return bold(cyan(title));
}

function cmd(name, desc) {
    return `  ${green(name.padEnd(12))} ${dim(desc)}`;
}

const USAGE = `
opencode-rich-presence - Discord Rich Presence plugin for OpenCode AI

${section("Usage")}:
  opencode-rpc <command> [options]

${section("Setup")}:
${cmd("install", "Set up Rich Presence for OpenCode (config + symlink)")}
${cmd("uninstall", "Remove Rich Presence configuration")}
${cmd("update", "Upgrade to latest stable release tag, or a specific ref")}

${section("Presence")}:
${cmd("on", "Enable Rich Presence (instant, keeps daemon alive)")}
${cmd("off", "Disable Rich Presence (instant, keeps daemon alive)")}
${cmd("info", "Show diagnostic information")}

${section("Daemon")}:
${cmd("restart", "Restart the daemon (kill + auto-respawn on next message)")}
${cmd("kill", "Stop the daemon permanently (use 'spawn' to start again)")}
${cmd("spawn", "Start the daemon again after a 'kill'")}

${section("General")}:
${cmd("help", "Show this message")}
${cmd("version", "Print version")}

${section("Options (update)")}:
  ${yellow("--stable")}         Force install latest stable tag (use to switch off dev)
  ${yellow("--ref REF")}        Install a specific git ref: tag, branch, or commit SHA.
                   Use this instead of \`npm install -g <url>#<ref>\`, which
                   hits a npm v11 bug that installs the package without
                   bin symlinks (the opencode-rpc command would be missing).
                   Examples:
                     opencode-rpc update --ref v3.3.0
                     opencode-rpc update --ref <branch-name>
                     opencode-rpc update --ref 6664bfb
                     opencode-rpc update --ref 471ce940ba316180fa08617dcb04ee1b59599e7f
  ${yellow("--dev [BRANCH]")}   Install latest commit on BRANCH (defaults to \`main\`,
                   which is currently v3.3.0). Combine with --repo for
                   forks.
  ${yellow("--repo OWNER/REPO")}  Install from a fork instead of the upstream repo.
                     Combine with --dev, --stable, or --ref:
                       opencode-rpc update --repo myname/opencode-rich-presence --ref my-branch

${section("Installation (one-time)")}:

  # Quick install (Linux, macOS, Windows via Git Bash / MSYS2 / Cygwin / WSL):
  curl -fsSL https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/install.sh | bash

  # Pin to a specific version:
  curl -fsSL https://raw.githubusercontent.com/Khip01/opencode-rich-presence/main/install.sh \\
    | ORP_VERSION=v3.3.0 bash

  # Manual tarball install (any platform):
  # Download from https://github.com/Khip01/opencode-rich-presence/releases/latest
  npm install -g ./opencode-rich-presence-v3.3.0.tgz

  # After install, set up the OpenCode plugin symlink + config:
  opencode-rpc install

  # Why not \`npm install -g Khip01/opencode-rich-presence#v3.3.0\`?
  # npm v11 has a bug installing global git deps: the package appears
  # to install (npm reports "added 1 package") but the opencode-rpc
  # binary is missing (\`zsh: command not found: opencode-rpc\`).
  # The package cannot fix this from its own package.json; always
  # install from a local tarball (curl installer or manual download).

${section("Update")}:
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
