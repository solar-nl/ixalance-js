# iXalance guest development

This tree contains the tooling and source needed to build new `.ixa` guests:

- `ixalance-sdk/` — the reusable guest runtime, headers, examples, tests, and
  production ports.
- `tools/` — the ELF-to-DOS/32A converter and `.ixa` container packer.

Production-specific ports live under `ixalance-sdk/ports/` so they consume the
same runtime and packaging path as any other SDK guest.
