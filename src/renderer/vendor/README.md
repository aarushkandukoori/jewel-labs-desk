# Vendored code

The screens run in Electron and, unchanged, on the website, with no build step, so these files are copied in from
npm packages. They are unchanged copies: never edit them, refresh them with the commands below.
`test/unit/renderer.test.js` checks that each one is still byte for byte the same as the installed package.

| file | copied from | version | license |
|------|-------------|---------|---------|
| `preact-htm.mjs` | `node_modules/htm/preact/standalone.mjs` (htm with Preact 10 bundled into the one file) | htm 3.1.1 | htm: Apache-2.0, Preact: MIT (both texts in `preact-htm.LICENSE.txt`) |
| `pdfjs/pdf.mjs`, `pdfjs/pdf.worker.mjs` | `node_modules/pdfjs-dist/build/` | pdfjs-dist 6.5.438 | Apache-2.0 (`pdfjs/LICENSE`) |
| `pdfjs/cmaps/` | `node_modules/pdfjs-dist/cmaps/` | pdfjs-dist 6.5.438 | BSD-3-Clause (`pdfjs/cmaps/LICENSE`) |
| `pdfjs/standard_fonts/` | `node_modules/pdfjs-dist/standard_fonts/` | pdfjs-dist 6.5.438 | Foxit fonts: BSD-3-Clause, Liberation fonts: GPL-2.0 with the font exception (`pdfjs/standard_fonts/LICENSE_*`) |

The app runs the Preact inside `preact-htm.mjs`, not the `preact` npm package: changing the `preact` version in
`package.json` does not change the screens. The `htm` package is only needed to refresh the copy.
The hidden page window (`src/main/rasterize-page.mjs`) uses the same pdf.js copy; `src/core` reads PDFs with the
`pdfjs-dist` package itself, so keep the two on the same version.

To refresh, from the repository folder, after `npm install`:

```sh
cp node_modules/htm/preact/standalone.mjs src/renderer/vendor/preact-htm.mjs
cp node_modules/pdfjs-dist/build/pdf.mjs node_modules/pdfjs-dist/build/pdf.worker.mjs src/renderer/vendor/pdfjs/
cp -R node_modules/pdfjs-dist/cmaps node_modules/pdfjs-dist/standard_fonts src/renderer/vendor/pdfjs/
cp node_modules/pdfjs-dist/LICENSE src/renderer/vendor/pdfjs/LICENSE
```

Then update the versions in this file and in `THIRD_PARTY_NOTICES.md`.
