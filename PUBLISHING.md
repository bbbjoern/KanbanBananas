# Publishing KanbanBananas

Publisher: `hypertxt` (display name "Hypertxt.org"). Extension id: `hypertxt.kanban-bananas`.
Published to the VS Code Marketplace and Open VSX (for Cursor and other VS Code forks).

## One-time setup

1. **Marketplace token (only for publishing by command; uploading needs none):** in Azure DevOps (dev.azure.com), create a Personal Access Token with
   organization "All accessible organizations" and scope **Marketplace → Manage**. Then:
   `npx vsce login hypertxt` (paste the token).
2. **Open VSX:** sign in at open-vsx.org with an Eclipse account, sign the publisher agreement,
   create an access token, and create the namespace once:
   `npx ovsx create-namespace hypertxt -p <token>`.
   For publishing, set `OVSX_PAT=<token>` in your shell (don't commit it).

## Each release

1. Bump `version` in `packages/extension/package.json` and add an entry to `packages/extension/CHANGELOG.md`.
2. Run the checks: `npm run typecheck && npm test && npm run test:integration -w kanban-bananas`.
3. Build the package: `npm run package -w kanban-bananas` → `packages/extension/kanban-bananas.vsix`.
4. Publish the same file to both:
   - **Marketplace, by upload (simplest):** marketplace.visualstudio.com/manage → publisher `hypertxt`.
     First release: **New extension → Visual Studio Code**, upload the `.vsix`. Later releases:
     the extension's **⋯ → Update**, upload the new `.vsix`. No token needed.
   - Marketplace, by command (alternative): `npm run publish:marketplace -w kanban-bananas` (needs `vsce login` above).
   - Open VSX: `npm run publish:openvsx -w kanban-bananas` (needs `OVSX_PAT`)
5. Commit and tag: `git tag v<version>`.

The README's screenshots are loaded from GitHub (`raw/HEAD/packages/extension/media/screenshots`),
so the repository must be public for them to show on the Marketplace page. Screenshots use invented
demo cards (`node packages/extension/scripts/demo-board.mjs`, then the Vite dev server), never real ones.
