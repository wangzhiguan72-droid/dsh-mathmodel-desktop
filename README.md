# dsh-mathmodel-desktop — DeepSeek Math-Modeling Desktop

A math-modeling-specific desktop distribution built on the official `dsh-desktop` Electron shell: it turns the bundled DeepSeek Harness (`@deepseek-ai/dsh` `0.1.5-rc.3`) Web GUI into an installable Windows desktop app with a bundled standalone Node.js runtime, the dsh host, and a preinstalled math-modeling profile (official web bundles + the dsh-web plugin collection + the **dsh-mathmodel** math-modeling plugin).

English | [中文](README.zh.md)

## Math-modeling capability

The bundled plugin `@deepseek-harness/dsh-mathmodel` 0.1.1 (`plugins/dsh-mathmodel`, wired into the profile as a `file:` dependency) provides:

- Manual skill cards (dynamic scan of `~/.dsh-mathmodel/skills/*/mathmodel-card.yml`; confirm writes a draft into the input box, never auto-sends)
- Dependency preflight (Python scientific stack, XeLaTeX, latexmk, Draw.io, Poppler)
- Vision understanding and controlled image generation (credential allowlist, paid-call confirmation, budget/quantity limits, secret redaction)
- The `editable_ppt_image` specialized image pipeline (Codex backend guard)
- Fail-closed version gate: `src/version.js` whitelist `0.1.1-rc.2 / 0.1.2-rc.1 / 0.1.5-rc.1 / 0.1.5-rc.2 / 0.1.5-rc.3`

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

See [test and rc.3 adaptation evidence](docs/test-fixtures-rc3.md) for test scopes and limits. Custom mathmodel/imagegen/editable-ppt presets are user-managed and are not bundled by this plugin.

See [Windows rc.3 verification](docs/windows-rc3-verification.md) for full-profile and release-artifact checks.

## Desktop updates (Windows 0.1.1+)

Windows desktop 0.1.2 connects the existing lower-left Harness update button to the desktop updater. When a newer desktop release is available, that button highlights it; clicking opens the desktop version details, with separate confirmations for download and installation. The desktop host reports update status without probing or running pnpm. Browser and ordinary CLI installations keep their existing update behavior. The publisher-controlled HTTPS feed carries an exact ZIP hash and length; the helper swaps complete application directories after exit and restores the previous release if the host or GUI cannot boot. The update settings menu can change the feed or disable startup checks. If the feed has no manifest, the button stays unhighlighted and the app explains that no update manifest is available.

Version 0.1.0 had no in-app update entry. Its one-time migration to 0.1.1 used the maintainer's `scripts/bootstrap-installed-desktop.mjs` at that time: the verified ZIP and NSIS package were checked, personal data was backed up, and the complete application was replaced at the existing install path. Isolated failure-recovery and successful-boot trials passed; the personal installation also migrated to 0.1.1 with a healthy GUI. The old program and personal data snapshots remain available. This is historical evidence for the first migration; the current bootstrap script accepts 0.1.0 and targets the verified 0.1.2 package. The personal installation has since updated from 0.1.1 to 0.1.2 through a full-directory swap and passed boot and GUI checks. The 0.1.2 repair package replaces the unpublished 0.1.1 release candidate; its online feed is not live yet. The maintenance CLI only supports read-only `--check`; its former automatic upgrade and partial rollback commands fail closed. See [verification evidence](docs/desktop-updates-verification.md).

Maintainers can run `node scripts/publish-desktop-release.mjs --plan` to verify the five local 0.1.2 release assets and update feed without credentials or a GitHub write. Publishing requires an approved source commit and matching remote `v0.1.2` tag; see the [release checks](docs/desktop-updates-verification.md#发布边界).
