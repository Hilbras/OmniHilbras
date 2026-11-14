# Installing and uninstalling

Two audiences, and the difference matters for what you need installed:

- **The desktop application** (`.deb`, `.exe`, `.dmg`) — a self-contained app. No Node, no pnpm, no git.
- **From source** — a checkout you run with `pnpm`. Needs Node 20+, pnpm and git.

## The first-run check

Whichever you used, the first thing to run is:

```bash
omnihilbras setup      # checks, says what is missing, offers to fix it
omnihilbras doctor     # the same checks, report only, no offers
```

`setup` prints what it found and gives you a menu: install the missing tools, see the full report, deal
with another version on the machine, or start the servers. It **shows the exact command before running
anything** and asks; `--yes` skips the question for automation and still prints it.

`doctor` never changes anything, which is what makes it safe to run in a script or on someone else's
machine. It exits `1` if something *blocking* was found.

Both report every other Omnihilbras installation they can find:

```
Other installations
  npm global
    @hilbras/omnihilbras@2.9.18  remove: npm rm -g @hilbras/omnihilbras
  on PATH
    /usr/bin/omnihilbras → /opt/OmniHilbras/omnihilbras
  app directories
    /opt/OmniHilbras
```

That is the failure this is for: two versions both answering on port `20138`, or an old copy on `PATH`
that keeps answering `omnihilbras --version` after you uninstalled — which makes an uninstall look like it
did nothing.

## Installing

### Desktop application

Download the artefact for your platform from
[the releases page](https://github.com/Hilbras/OmniHilbras/releases), then install it the way your OS
does: `sudo dpkg -i omnihilbras_<version>_amd64.deb`, run the `.exe`, or drag the `.dmg` to Applications.

### From source

```bash
git clone https://github.com/Hilbras/OmniHilbras.git
cd OmniHilbras
pnpm install
npm link            # puts `omnihilbras` on your PATH, pointed at this checkout
omnihilbras setup   # check the tools before starting anything
```

> **`npm i -g @hilbras/omnihilbras` does not install this project yet.** Publishing is suspended during
> the Kernel restructure: every manifest in this repository is `private: true`, so there is nothing to
> publish. The name on npm today (`@hilbras/omnihilbras@2.9.18`) is the **previous** project. `npm link`
> from a checkout is the supported path until a publishable manifest exists.

## Uninstalling

Two ways, and the second is the one that actually removes everything.

```bash
# The package only:
npm rm -g @hilbras/omnihilbras

# Everything: every package name, every version, leftover binaries, app directories, autostart entries:
bash scripts/uninstall/unix.sh        # Linux and macOS
powershell -File scripts/uninstall/windows.ps1
```

Both scripts do the same four things, in this order:

1. **Find everything and print it.** Nothing is removed before you have seen the list.
2. Remove the npm packages — **every name this project has shipped under**, not just the one you type —
   and any leftover binary on `PATH`.
3. Remove application directories and autostart entries.
4. **Leave your data alone** unless you ask.

| Flag | What it does |
| --- | --- |
| `--dry-run` / `-DryRun` | Print what would be removed and remove nothing. Also what happens with no terminal to confirm on. |
| `--purge-data` / `-PurgeData` | Also remove the vault and configuration. **Credentials live there** — see below. |
| `--yes` / `-Yes` | Do not ask for confirmation. |
| `--help` | The script's own help. |

It does **not** kill processes. It reports them and tells you to stop them, because deciding that a
process it did not start should die is how an uninstaller becomes the thing that broke your evening. (The
previous project's launcher did exactly that: it scanned `ps` for anything matching its own name —
including any process started from a directory with `OmniHilbras` in the path — and killed it.)

### What `--purge-data` removes

Your data directories:

| Platform | Path |
| --- | --- |
| All | `~/.omnihilbras` |
| Linux | `$XDG_CONFIG_HOME/omnihilbras`, `$XDG_STATE_HOME/omnihilbras` |
| macOS | `~/Library/Application Support/omnihilbras` |
| Windows | `%APPDATA%\omnihilbras`, `%LOCALAPPDATA%\omnihilbras` |

The first holds the vault: every saved provider credential and every gateway key. Removing it cannot be
undone — provider sessions and API keys have to be added again from scratch. That is why it is a separate
flag and not the default.

`OMNIHILBRAS_UNINSTALL_SKIP_SYSTEM=1` leaves `/opt` and `/usr/lib` alone, which is what a user-scope
install wants and what the test suite uses so it is not asserting about whatever is in `/opt`.

### Leftovers the uninstallers know about

- **A binary on `PATH` that npm does not know about** — what a failed or interrupted install leaves, and
  the reason an uninstall can appear to have done nothing.
- **Every package name**, because `npm rm` only removes the name you type.
- **Autostart entries** — a launch agent, a `.desktop` file, or a Startup-folder shortcut.
- **Application directories** needing root (`/opt/OmniHilbras`, `/usr/lib/omnihilbras`). The script tries
  without privileges, then reports the exact `sudo rm -rf` to run rather than asking for a password
  mid-script.
