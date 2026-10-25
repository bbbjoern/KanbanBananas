# Boards outside VS Code (Xcode projects and others)

A repository you don't open in VS Code, such as an Xcode project, can still have a KanbanBananas board in SuperTask, and SuperTask can still change its cards. A small background process on your Mac, `kanban sync --write`, does what the VS Code extension does otherwise: it keeps SuperTask's copy of the board current and writes SuperTask's changes into the card files.

Xcode never notices any of this. The board is a folder of markdown files in the repository (`.devtool/features`), committed like any other files. Nothing is added to the Xcode project.

## What you need

- Node 20 or newer (`node --version`).
- This repository (KanbanBananas) on your Mac, up to date: `git pull`.
- The hub URL: `https://projects.hypertxt.org/api/hub`, the same value as **Project hub: URL** in VS Code's settings.
- A machine token from SuperTask for the repository you are connecting. It's the same kind of token you store in VS Code with *KanbanBananas: Project Hub: Set Token…*.

## Once per Mac: install the `kanban` command

In Terminal, in the KanbanBananas folder:

```sh
npm install
npm run install-cli
```

This builds the CLI and installs it as `/opt/homebrew/bin/kanban`. Check it with `kanban version`.

## Once per repository: connect it

Still in the KanbanBananas folder:

```sh
npm run connect-repo -- ~/Dev/"Swift Apps"/Mirazo/Mirazo --hub https://projects.hypertxt.org/api/hub
```

When it asks for the token, paste it and press Enter. The token is not shown while you paste. To skip the prompt, copy the token and pipe it in instead:

```sh
pbpaste | npm run connect-repo -- ~/Dev/"Swift Apps"/Mirazo/Mirazo --hub https://projects.hypertxt.org/api/hub
```

### The repository path

This is the folder that holds the repository's `.git`, the folder you would `cd` into for `git status`. It is *not* the `.xcodeproj` and not a folder inside the repository.

**Xcode often puts the repository one level down.** A project created with "Create Git repository" ends up as `Mirazo/Mirazo/.git`, so the repository path is `~/Dev/"Swift Apps"/Mirazo/Mirazo`, not `…/Mirazo`. To find it: `cd` into the project folder and run `git rev-parse --show-toplevel`; it prints the path to use. If you pass the outer folder, the script notices and tells you which folder to pass instead.

- Use an absolute path, or start it with `~` for your home folder: `~/Dev/"Swift Apps"/Mirazo/Mirazo`.
- A relative path works too. It is relative to the folder you are in when you run the command (here: the KanbanBananas folder), so `../../"Swift Apps"/Mirazo/Mirazo` would also work. Absolute is less confusing.
- Put quotes around any part with spaces (`"Swift Apps"`), or the shell splits the path.
- Tip: type `npm run connect-repo -- ` and drag the repository folder from Finder into Terminal. That pastes the full path, correctly escaped.

### The hub URL

The full base URL of the hub's API, including `/api/hub`: `https://projects.hypertxt.org/api/hub`. A trailing slash doesn't matter. The script refuses anything that doesn't start with `https://` (or `http://`).

### What the command does

1. **Board.** If the repository has no `.devtool` folder, it creates `.devtool/features`, an empty board. Commit `.devtool/` with the repository.
2. **Check.** It syncs once with the URL and token you gave. If SuperTask refuses (a wrong URL or token), it stops and saves nothing. Fix the URL or token and run it again.
3. **Token.** After a successful check, it saves the token in `~/.config/kanban/<repo>.token`, readable only by you. Running the command again and pressing Enter at the prompt keeps the saved token.
4. **Background agent.** It installs a launchd agent, `org.hypertxt.kanban-sync.<repo>`, which runs `kanban sync --write` in the repository. The agent starts at login and restarts if it stops.

`<repo>` is the repository folder's name in lower case, with anything other than letters and digits turned into `-`. For example, `Mirazo` becomes `mirazo`, and `My App` becomes `my-app`.

## Check that it works

1. In SuperTask, the repository's board appears (empty, if the board is new).
2. Create a card in SuperTask. In the repository, `git status` shows a new file in `.devtool/features/`.
3. Edit a card file in any editor and save it. SuperTask shows the change within a moment.
4. Follow the log while you try things:

   ```sh
   tail -f ~/Library/Logs/kanban-sync-mirazo.log
   ```

   `sync: connected` means it's running. Every change SuperTask asks for is listed in the log with what became of it.

## Where are the cards?

In the repository, in `.devtool/features/` (cards in Done are in `.devtool/features/done/`). One markdown file per card, named after its title and date, for example `ui-overhaul-2026-10-25.md`.

You won't see them at first:

- **Finder** hides folders whose name starts with a dot. Press **⌘⇧.** in a Finder window to show hidden files (press it again to hide them), or open the folder from Terminal: `open ~/Dev/"Swift Apps"/Mirazo/Mirazo/.devtool/features`.
- **Xcode** shows only files that belong to the project, and the board doesn't, on purpose: it stays out of your project and your builds. To see the cards in Xcode anyway, drag `.devtool/features` into the navigator, choose **Create folder references**, and leave every target unchecked. Xcode then lists the files without building them. This changes `project.pbxproj`.
- **git** sees them: `git status` lists `.devtool/` as new. **Commit `.devtool/`** with the repository, or the board exists only on this Mac.

## With VS Code in the picture

If you open the same repository in VS Code (with the extension's **Project hub** set up), the extension takes over: the log says *"VS Code is open and syncs the board itself; waiting"*. When you close VS Code, the agent takes over again within about 10 seconds. You don't have to stop or start anything.

A change that arrives in SuperTask at the very moment VS Code opens the project is refused with *"VS Code just opened this project…; try again"*. Repeat it in SuperTask.

## After updating KanbanBananas

After a `git pull` here, update the command and restart the agents:

```sh
npm run install-cli
launchctl kickstart -k gui/$(id -u)/org.hypertxt.kanban-sync.mirazo     # once per connected repository
```

Rebuild the VS Code extension too (`npm run package -w kanban-bananas`, then *Extensions → ⋯ → Install from VSIX…*, then reload the window).

## Disconnecting a repository

```sh
npm run connect-repo -- ~/Dev/"Swift Apps"/Mirazo/Mirazo --remove
```

This stops and deletes the agent. The board (`.devtool`) and the token file stay. To remove the token too: `rm ~/.config/kanban/mirazo.token`.

## When something's wrong

| You see | What it means, what to do |
|---|---|
| `kanban is not on your PATH` | Run `npm run install-cli` first. |
| `which repository?` | The repository's folder is missing after `connect-repo --`. Add it, or drag the folder from Finder into Terminal before pressing Return. |
| `not a folder: …` | The path is wrong, or contains spaces without quotes. Drag the folder from Finder instead. |
| `The hub rejected the token.` | The token is wrong, or for another repository. Get a fresh one from SuperTask and run the command again. |
| `This token is for … not …` | The token belongs to another repository. SuperTask knows a repository by its `origin` git remote (or its folder path when it has none). |
| `Hub protocol … doesn't match …: update …` | One side is older. Update the side the message names (pull + `install-cli` here, or SuperTask). |
| Changes in SuperTask come back refused as *stale* | Someone changed that field on the card in the meantime. SuperTask shows the card as it is now; make the change again. |
| `launchctl could not start it` | Usually an older agent with the same name is stuck. Run the command with `--remove`, then connect again. |
| The board in SuperTask doesn't update | Look at the log (`tail -50 ~/Library/Logs/kanban-sync-<repo>.log`). `offline` means it can't reach SuperTask and keeps retrying. `refused` names the reason. |

## Without the background agent

To sync only while a Terminal window is open (for example, to try it out), add `--no-agent`. The script then does steps 1 to 3 and prints the command to run in the repository instead:

```sh
cd ~/Dev/"Swift Apps"/Mirazo/Mirazo
KANBAN_HUB_TOKEN_FILE=~/.config/kanban/mirazo.token kanban sync --write --hub https://projects.hypertxt.org/api/hub
```

Ctrl-C stops it. Without `--write`, SuperTask can see the board but not change it.
