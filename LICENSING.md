# Licensing and provenance

This repository contains code under compatible licenses, plus optional demo assets that
are not part of the repository license.

## iXalance-js runtime

Except for the XM component identified below, the source code and project documentation are:

> Copyright © 2026 Jasper Schelling  
> SPDX-License-Identifier: GPL-2.0-only

The complete license is in [LICENSE](LICENSE).

The container decoder, executable loader and host ABI are a JavaScript reimplementation
derived from [iXalance 1.0.5](https://www.libsdl.org/projects/ixalance/) by The Black Lotus
and Jarno Paananen. That source distribution contains GNU GPL version 2 but no explicit “or
any later version” notice. This project therefore uses the conservative `GPL-2.0-only`
identifier rather than assuming permission to relicense the derived work under a later GPL.

## XM replay component

[`lib/xm.js`](lib/xm.js) is based on
[ft2-clone](https://github.com/8bitbubsy/ft2-clone)’s BSD-licensed FT2 replay code and
tables:

> Copyright © 2016–2026 Olav Sørensen  
> SPDX-License-Identifier: BSD-3-Clause

Its notice and disclaimer are retained in
[LICENSES/BSD-3-Clause-ft2-clone.txt](LICENSES/BSD-3-Clause-ft2-clone.txt). BSD-3-Clause is
compatible with GPL version 2, so the component can be distributed as part of the GPL
runtime while retaining its own notice.

## Demo binaries and rendered media

The `.ixa` files, extracted executables, music, graphics, screenshots and reference video
are not covered by either software license above. They remain copyright The Black Lotus
and the credited individual authors.

The locally built Square `.ixa` is likewise a separate production rather than
GPL-covered runtime code. Although its executable is rebuilt through the guest SDK, its
embedded music, graphics and packed production data remain copyright Pulse and the
credited Square authors.

The public repository excludes those files. `npm run data` obtains the unmodified `.ixa`
containers from the official iXalance archive and verifies their hashes locally. This is
not a grant to redistribute them; see [data/README.md](data/README.md) and the original
release documentation for their terms.

## Local research sources

The ignored `source/`, `prods/`, `video/`, `out/`, `screenshots/` and `deploy/` directories
are local research or generated material. Their presence in a working copy does not make
them part of the Git repository or change their respective licenses.
