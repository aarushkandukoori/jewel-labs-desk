# Third-party notices

Jewel Labs Desk itself is not open source (see `LICENSE`). It ships the third-party components below, each under its
own license. The full license texts travel with the files: in the installer (everything under `src/` and the
production `node_modules/` packages) and on the website (`scripts/build-site.js` copies `src/renderer/` and the fonts).

## Copied into this repository

| component | version | license | copyright | where it is | full license text |
|-----------|---------|---------|-----------|-------------|-------------------|
| pdf.js | 6.5.438 | Apache-2.0 | Mozilla Foundation | `src/renderer/vendor/pdfjs/` (pdf.mjs, pdf.worker.mjs) | `src/renderer/vendor/pdfjs/LICENSE` |
| pdf.js CMaps | from pdf.js 6.5.438 | BSD-3-Clause | Adobe Systems Incorporated | `src/renderer/vendor/pdfjs/cmaps/` | `src/renderer/vendor/pdfjs/cmaps/LICENSE` |
| Foxit fonts (pdf.js standard fonts) | from pdf.js 6.5.438 | BSD-3-Clause | PDFium Authors | `src/renderer/vendor/pdfjs/standard_fonts/Foxit*` | `src/renderer/vendor/pdfjs/standard_fonts/LICENSE_FOXIT` |
| Liberation Sans (pdf.js standard fonts) | from pdf.js 6.5.438 | GPL-2.0 with the font exception | Red Hat, Inc. | `src/renderer/vendor/pdfjs/standard_fonts/Liberation*` | `src/renderer/vendor/pdfjs/standard_fonts/LICENSE_LIBERATION` |
| htm | 3.1.1 | Apache-2.0 | Google Inc. | `src/renderer/vendor/preact-htm.mjs` | `src/renderer/vendor/preact-htm.LICENSE.txt` |
| Preact (inside the htm bundle) | 10 | MIT | Jason Miller | `src/renderer/vendor/preact-htm.mjs` | `src/renderer/vendor/preact-htm.LICENSE.txt` |
| Geist and Geist Mono | 1.9.2 | OFL-1.1 | Vercel, in collaboration with basement.studio | `src/renderer/fonts/`, `src/core/papers/fonts/` | `src/renderer/fonts/OFL.txt`, `src/core/papers/fonts/OFL.txt` |
| Inter | 5.3.0 (@fontsource/inter) | OFL-1.1 | The Inter Project Authors | `src/renderer/fonts/` | `src/renderer/fonts/OFL.txt` |
| OFAC SDN list snapshot | see `assets/ofac/snapshot.json` | U.S. Government work | U.S. Department of the Treasury, OFAC | `assets/ofac/` | none: works of the U.S. Government are not subject to U.S. copyright |

The fonts are unchanged copies. The papers the app builds embed subsets of Geist; the OFL's rule that the fonts stay
under the OFL does not apply to documents made with them.

## npm packages the app installs

The installer carries these packages (and what they depend on) in `node_modules/`, each under the license its own
`package.json` declares. Most of them keep the license text in their folder.

| package | version | license |
|---------|---------|---------|
| tesseract.js | 7.0.0 | Apache-2.0 |
| tesseract.js-core | 7.0.0 | Apache-2.0 |
| @tesseract.js-data/eng (the English OCR model) | 1.0.0 | MIT |
| SheetJS (xlsx) | 0.20.3 | Apache-2.0 |
| pdfjs-dist | 6.5.438 | Apache-2.0 |
| pdf-lib | 1.17.1 | MIT |
| @pdf-lib/fontkit | 1.1.1 | MIT |
| jszip | 3.10.2 | MIT (offered as MIT or GPL-3.0-or-later; used under MIT) |
| qrcode | 1.5.4 | MIT |
| imapflow | 2.12.1 | MIT |
| mailparser | 3.14.4 | MIT |
| nodemailer | 10.6.0 | MIT-0 |
| @supabase/supabase-js | 2.119.0 | MIT |

## Electron

The app runs on Electron 45.3.2 (MIT), which includes Chromium. The installed app carries their notices next to the app
(on a Mac in `Jewel Labs.app/Contents/Resources/`: `LICENSE.electron.txt` and `LICENSES.chromium.html`).
