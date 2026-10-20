# Publishing KanbanBananas

Publisher: `Hypertxtorg` (display name "Hypertxt.org"). Extension id: `Hypertxtorg.kanban-bananas`
(VS Code treats ids case-insensitively and shows them as `hypertxtorg.kanban-bananas`).
Published to the VS Code Marketplace and Open VSX (for Cursor and other VS Code forks).

## One-time setup

1. **Marketplace token (only for publishing by command; uploading needs none):** in Azure DevOps (dev.azure.com), create a Personal Access Token with
   organization "All accessible organizations" and scope **Marketplace → Manage**. Then:
   `npx vsce login Hypertxtorg` (paste the token).
2. **Open VSX:** sign in at open-vsx.org with an Eclipse account, sign the publisher agreement,
   create an access token, and create the namespace once:
   `npx ovsx create-namespace Hypertxtorg -p <token>`.
   For publishing, set `OVSX_PAT=<token>` in your shell (don't commit it).

## Packages for other apps

Apps that host the board or speak the hub protocol (SuperTask) install two packages from
GitHub Packages, published by `scripts/publish-packages.mjs` under the repository owner's
scope, as GitHub Packages requires: `@bbbjoern/kanban-bananas-core` (the `packages/core`
build, `dist/` and `src/`) and `@bbbjoern/kanban-bananas-webview` (the board bundle,
`index.js` and `index.css`). The release script publishes both with the release version;
it needs `NODE_AUTH_TOKEN` set to a GitHub token with `write:packages`. Between releases,
publish a prerelease by hand when a consumer needs a change early (it goes under the `dev`
dist-tag; consumers pin exact versions):

```sh
NODE_AUTH_TOKEN=<token> node scripts/publish-packages.mjs core --version 1.7.0-dev.2
```

A consumer aliases the package back to its workspace name, for example in SuperTask's
package.json: `"@kanban-bananas/core": "npm:@bbbjoern/kanban-bananas-core@1.7.0-dev.1"`,
with `@bbbjoern:registry=https://npm.pkg.github.com` in its `.npmrc`.

## Between releases

Note every user-visible change under **`## Unreleased`** at the top of
`packages/extension/CHANGELOG.md` as you go. Commits between releases get no tag.

## Each release

**The short way:** `npm run release -- <x.y.z>` does steps 1–3 and 5 below in one go:
checks (typecheck, unit and integration tests), version bump, changelog `## Unreleased` →
`## <x.y.z> (Preview)`, package (checked for the right version and no keywords), commit,
annotated tag, and `git push --follow-tags`. It stops before changing anything if the version
isn't newer, the tag exists, or the changelog has nothing under Unreleased; it asks before
including uncommitted changes. Options: `--skip-integration` (skip the VS Code tests),
`--dry-run` (show what would happen). Then do step 4 (try it) and step 6 (upload).

The long way, by hand:

1. **Version:** bump `version` in `packages/extension/package.json`, and rename `## Unreleased`
   in `packages/extension/CHANGELOG.md` to that version (e.g. `## 1.2.0 (Preview)`).
2. Run the checks: `npm run typecheck && npm test && npm run test:integration -w kanban-bananas`.
3. Build the package: `npm run package -w kanban-bananas` → `packages/extension/kanban-bananas.vsix`.
   Check it still has no `keywords` (see "Marketplace content filter" below).
4. **Try it:** install the `.vsix` (Extensions → ⋯ → Install from VSIX…), then **reload the window**
   (Developer: Reload Window). Without the reload, VS Code keeps running the previous version's code,
   and new features look broken. The KanbanBananas log shows which build is running.
5. Commit, tag and push, tag included:
   `git commit …`, `git tag -a v<version> -m "KanbanBananas <version>"`, `git push origin main --follow-tags`.
   (Plain `git push` doesn't send tags.)
6. Publish the same file to both:
   - **Marketplace, by upload (simplest):** marketplace.visualstudio.com/manage → publisher `Hypertxtorg`.
     First release: **New extension → Visual Studio Code**, upload the `.vsix`. Later releases:
     the extension's **⋯ → Update**, upload the new `.vsix`. No token needed.
   - Marketplace, by command (alternative): `npm run publish:marketplace -w kanban-bananas` (needs `vsce login` above).
   - Open VSX: `npm run publish:openvsx -w kanban-bananas` (needs `OVSX_PAT`)

The README's screenshots are loaded from GitHub (`raw/HEAD/packages/extension/media/screenshots`),
so the repository must be public for them to show on the Marketplace page. Screenshots use invented
demo cards (`node packages/extension/scripts/demo-board.mjs`, then the Vite dev server), never real ones.

## Marketplace content filter (found 2026-09-27)

The Marketplace rejected uploads with "Your extension has suspicious content" until the
`keywords` field was removed from `packages/extension/package.json` (kanban, markdown, board,
task, project management, cards). Established by uploading stripped test packages: without
`keywords` accepted, with only `keywords` added rejected. Leave `keywords` out, or add them back
one at a time to find the one it objects to. Names of other products (Claude Code, Cursor, the old
Kanban Markdown extension) were also kept out of the Marketplace README and description for the
first release; that combination is untested, so reintroduce them in a separate update if wanted.
