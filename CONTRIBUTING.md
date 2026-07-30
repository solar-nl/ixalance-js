# Contributing

Thanks for helping preserve and improve iXalance.

## Setup

The project has no package dependencies and requires Node.js 18 or newer:

```sh
npm run data
npm test
npm run serve
```

The first command downloads the original demo containers from the official iXalance
archive and verifies their hashes. Do not commit `.ixa`, extracted executable, generated
XM/WAV, reference-video or deploy-output files.

## Changes

- Keep the interpreter as the correctness reference for JIT work.
- Add a focused differential fixture for instruction, timer or XM replay changes.
- Run `npm test` before submitting a change.
- Keep benchmark checkpoints and bulk captures under `out/`.
- Record retained performance results under `results/` only when they support a written
  optimization note.

By contributing to the runtime or documentation, you agree that your contribution is
licensed under `GPL-2.0-only`. Contributions made specifically to `lib/xm.js` are licensed
under `BSD-3-Clause`, matching that component’s upstream license.
