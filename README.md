# dsh-mathmodel-desktop — DeepSeek Math-Modeling Desktop

A math-modeling-specific desktop distribution built on the official `dsh-desktop` Electron shell: it turns the latest DeepSeek Harness (`@deepseek-ai/dsh` `0.1.5-rc.1`) Web GUI into an installable Windows desktop app with a bundled standalone Node.js runtime, the dsh host, and a preinstalled math-modeling profile (official web bundles + the dsh-web plugin collection + the **dsh-mathmodel** math-modeling plugin).

English | [中文](README.zh.md)

## Math-modeling capability

The bundled plugin `@deepseek-harness/dsh-mathmodel` 0.1.1 (`plugins/dsh-mathmodel`, wired into the profile as a `file:` dependency) provides:

- The `mathmodel` mode + manual skill cards (dynamic scan of `~/.dsh/skills/*/mathmodel-card.yml`; confirm writes a draft into the input box, never auto-sends)
- Dependency preflight (Python scientific stack, XeLaTeX, latexmk, Draw.io, Poppler)
- Vision understanding and controlled image generation (credential allowlist, paid-call confirmation, budget/quantity limits, secret redaction)
- The `editable_ppt_image` specialized image pipeline (Codex backend guard)
- Fail-closed version gate: `src/version.js` whitelist `0.1.1-rc.2 / 0.1.2-rc.1 / 0.1.5-rc.1`

## Build

```sh
npm install
npm run prepare-runtime
npm run dist:win         # dist/*.exe (nsis) + *.zip
```

`npm start` runs the app unpackaged against the staged `resources/runtime/` for development.

See [README.zh.md](README.zh.md) for the full documentation (layout, upgrade path, security model, known limitations).
