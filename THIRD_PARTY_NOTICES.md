# Third-party notices / 第三方开源库声明

This plugin bundles the following third-party libraries (in `client/vendor/`) and
depends on the following npm packages. Each is used under its own license; the
copyright notices and sources are listed here.

## Bundled libraries — `client/vendor/`

### docx-preview (docxjs)
- Used for: real browser-side Word (`.docx`) preview
- License: **Apache License 2.0**
- Copyright: Volodymyr Baydalka
- Source: <https://github.com/VolodymyrBaydalka/docxjs>
- License text: <https://www.apache.org/licenses/LICENSE-2.0>

### JSZip
- Used for: unzipping the OOXML/Office package parts
- License: **MIT** (dual-licensed MIT or GPLv3; this project uses it under MIT)
- Copyright: 2009-2016 Stuart Knightley
- Source: <https://github.com/Stuk/jszip>
- License text: <https://github.com/Stuk/jszip/blob/main/LICENSE.markdown>

### Chart.js
- Used for: charts rendered inside the PowerPoint (`.pptx`) preview
- Version: 4.4.1
- License: **MIT**
- Copyright: 2023 Chart.js Contributors
- Source: <https://www.chartjs.org>

### PptxViewJS (`pptxviewjs`)
- Used for: real browser-side PowerPoint (`.pptx`) preview
- License: **MIT**
- Copyright: © 2025 gptsci.com (npm author: Alex Wong)
- npm: <https://www.npmjs.com/package/pptxviewjs>
- CDN / source build: <https://cdn.jsdelivr.net/npm/pptxviewjs@1.1.9>

## Runtime npm dependencies (not vendored into the package)

These are declared as `dependencies` and resolved on the host at install time;
their own `LICENSE` files ship inside `node_modules`.

- `mammoth` — **BSD-2-Clause** (Word → HTML preview)
- `exceljs` — **MIT** (spreadsheet parsing)

## Note

MIT, Apache-2.0 and BSD-2-Clause licenses require retaining the copyright notice
and license text. The minified vendor files `docx-preview.min.js`,
`jszip.min.js`, and `chart.umd.min.js` already carry their license banners at
the top of the files. The full license texts are available at the sources above.
