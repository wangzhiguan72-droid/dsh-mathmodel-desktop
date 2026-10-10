# dsh-mathmodel-desktop — DeepSeek Math-Modeling Desktop

A general-purpose coding desktop distribution built on the official `dsh-desktop` Electron shell. “Math-Modeling Desktop” is the distribution name. The current 0.1.3 source packages the DeepSeek Harness (`@deepseek-ai/dsh` `0.2.0-rc.2`) Web GUI, a standalone Node.js runtime, the dsh host, and a preinstalled profile with the official web bundles, `@linxin666/dsh-web-all` `0.4.5`, and the **dsh-mathmodel** extension. The published 0.1.2 desktop still contains Harness `0.1.5-rc.3` until the new desktop releases are published and installed.

English | [中文](README.zh.md)

## Math-modeling capability

The bundled plugin `@deepseek-harness/dsh-mathmodel` 0.1.1 (`plugins/dsh-mathmodel`, wired into the profile as a `file:` dependency) provides:

- Manual skill cards (dynamic scan of `~/.dsh-mathmodel/skills/*/mathmodel-card.yml`; confirm writes a draft into the input box, never auto-sends)
- Dependency preflight (Python scientific stack, XeLaTeX, latexmk, Draw.io, Poppler)
- Vision understanding and controlled image generation (credential allowlist, paid-call confirmation, budget/quantity limits, secret redaction)
- The `editable_ppt_image` specialized image pipeline (Codex backend guard)
- Fail-closed version gate: `src/version.js` includes `0.2.0-rc.2` alongside the previously supported RC versions.

## Build

```sh
npm install
npm run prepare-runtime
npm run dist:win         # dist/*.exe (nsis) + *.zip
```

`npm start` runs the app unpackaged against the staged `resources/runtime/` for development.

Wait for runtime staging to finish before packaging. The distributed profile uses `build/profile.cordis.patch.yml`, with hooks and skills resolved under the selected `DSH_HOME`. This build's uninstaller preserves personal Harness data and external skill libraries. Upgrading an existing installation needs separate verification because it invokes the previous uninstaller.

On Windows, `npm run verify:win` launches the unpacked EXE in a temporary home and checks the full profile, first seed, restart, relocation and preserved user patch. Pass a different unpacked directory as an argument. It creates a skill fixture, uses an isolated child environment, preserves diagnostics and clears its authenticated URL on exit. `DSH_DESKTOP_USER_DATA` isolates Electron data during verification; `DSH_DESKTOP_HEADLESS=1` hides the window.

The separate `build-windows-install-fixture.mjs` and `verify-windows-install.mjs` scripts build and verify an NSIS package with a fixed test identity. They check compiler identity and hashes before installing, run the installed EXE, then uninstall and verify preserved data and the existing production installation. See [Git Graph and NSIS verification](docs/windows-git-graph-nsis-followup.md) for commands and results.

See [README.zh.md](README.zh.md) for the full documentation (layout, upgrade path, security model, known limitations).

See [historical rc.3 test and adaptation evidence](docs/test-fixtures-rc3.md) for that release's test scopes and limits. Custom mathmodel/imagegen/editable-ppt presets are user-managed and are not bundled by this plugin.

See [historical Windows rc.3 verification](docs/windows-rc3-verification.md) for that release's full-profile and artifact checks. Current update and rollback evidence is recorded in [desktop update verification](docs/desktop-updates-verification.md).

## Desktop updates (Windows 0.1.1+)

Windows desktop 0.1.2 connected the existing lower-left Harness update button to the desktop updater. When a newer desktop release appears, the button highlights it. The user reviews the version, confirms download, then separately confirms installation and restart; the app downloads, verifies, and replaces the complete desktop package without manual ZIP extraction. Browser and ordinary CLI installations keep their own update behavior. The update settings menu can change the feed or disable startup checks.

The 0.1.3 source upgrades Harness to `0.2.0-rc.2`. Its session format changes from V3 to V4, so the release route uses two desktop packages: `0.1.3-bridge.1` first installs a data-aware updater while retaining the V3 runtime, then `0.1.3` installs the V4 runtime. The updater snapshots the application home and Electron user data before a format change and restores them with the previous program on failed boot or manual rollback. After both packages and the routed update manifest are published, the existing 0.1.2 client will offer the bridge; the bridge will offer 0.1.3. Each installation still asks for confirmation. A new official Harness release does not itself publish a new desktop package.

Version 0.1.0 had no in-app update entry. Its one-time migration to 0.1.1 used the maintainer's `scripts/bootstrap-installed-desktop.mjs` at that time: the verified ZIP and NSIS package were checked, personal data was backed up, and the complete application was replaced at the existing install path. Isolated failure-recovery and successful-boot trials passed; the personal installation also migrated to 0.1.1 with a healthy GUI. The old program and personal data snapshots remain available. The personal installation later updated from 0.1.1 to 0.1.2 through a full-directory swap and passed boot and GUI checks. The published [v0.1.2 release](https://github.com/wangzhiguan72-droid/dsh-mathmodel-desktop/releases/tag/v0.1.2) replaced the unpublished 0.1.1 candidate. These are historical results; the 0.1.3 personal installation and public release are still pending verification. The maintenance CLI only supports read-only `--check`; its former automatic upgrade and partial rollback commands fail closed. See [verification evidence](docs/desktop-updates-verification.md).

The personal installation has now passed the two-step update to 0.1.3 and an independent check of its original sessions, three connections, credentials, shared skills, and uninstaller. The historical v0.1.2 release is tied to source commit `7c1a31e89d1582b73bb8fa20f67e595c23b833d2`. The current release planner verifies both the bridge and kernel assets and their routed manifest before publication; see the [release checks](docs/desktop-updates-verification.md#发布边界) for publication receipts.
