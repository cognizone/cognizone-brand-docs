#!/usr/bin/env node
// Usage: node pdf-print.js <input.html> <output.pdf> <title> <date> <logo.png>

const puppeteer = require('puppeteer');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');

const [,, htmlFile, outputPdf, title, date, logoPath, footerTitle, mermaidJsPath] = process.argv;

const GREEN = '#058775';
const GRAY  = '#666666';

const logoBase64 = logoPath && fs.existsSync(logoPath)
  ? `data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}`
  : '';

const fontPath = path.join(__dirname, 'fonts', 'Roboto[wdth,wght].ttf');
const fontBase64 = fs.existsSync(fontPath)
  ? fs.readFileSync(fontPath).toString('base64')
  : null;

const FONT = fontBase64
  ? `<style>@font-face { font-family: 'Roboto'; src: url('data:font/ttf;base64,${fontBase64}') format('truetype'); font-weight: 100 900; }</style>`
  : '';

const headerTemplate = `
  ${FONT}
  <div style="width:100%; box-sizing:border-box; padding:0 20mm;">
    <div style="
      display: flex; align-items: center; justify-content: space-between;
      padding-bottom: 4pt;
      border-bottom: 0.5px solid ${GREEN};
      font-size: 8pt; font-family: 'Roboto', sans-serif; color: ${GRAY};
    ">
      ${logoBase64 ? `<img src="${logoBase64}" style="height:18px; width:auto; max-width:110px;">` : '<span></span>'}
      <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:70%; text-align:right;">
        ${title || ''}
      </span>
    </div>
  </div>`;

const footerTemplate = `
  ${FONT}
  <div style="width:100%; box-sizing:border-box; padding:0 20mm;">
    <div style="
      display: flex; align-items: center; justify-content: space-between;
      padding-top: 4pt;
      border-top: 0.5px solid ${GREEN};
      font-size: 8pt; font-family: 'Roboto', sans-serif; color: ${GRAY};
    ">
      <span>${footerTitle || ''}</span>
      <span class="pageNumber"></span>
    </div>
  </div>`;

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  await page.goto(pathToFileURL(htmlFile).href, { waitUntil: 'networkidle0' });

  // Force light color scheme so mermaid diagrams don't pick up dark mode
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);

  // Render mermaid diagrams (if any) before TOC page-number calculation
  const hasMermaid = await page.evaluate(() => document.querySelectorAll('pre.mermaid').length > 0);
  if (hasMermaid && mermaidJsPath) {
    await page.addScriptTag({ path: mermaidJsPath });
    await page.evaluate(async () => {
      mermaid.initialize({ startOnLoad: false, theme: 'neutral' });
      await mermaid.run();
    });
  }

  // Inject page numbers into TOC entries
  await page.evaluate(() => {
    const A4_HEIGHT_PX = 1122.5; // A4 at 96dpi (297mm)

    function absoluteTop(el) {
      let top = 0;
      while (el) { top += el.offsetTop; el = el.offsetParent; }
      return top;
    }

    document.querySelectorAll('#TOC a[href^="#"]').forEach(link => {
      const target = document.getElementById(link.getAttribute('href').slice(1));
      const pageNum = target ? Math.floor(absoluteTop(target) / A4_HEIGHT_PX) + 1 : '';

      const title = link.textContent;
      link.innerHTML = `
        <span class="toc-title">${title}</span>
        <span class="toc-leader"></span>
        <span class="toc-page">${pageNum}</span>`;
    });
  });

  await page.pdf({
    path: outputPdf,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate,
    footerTemplate,
    margin: { top: '25mm', bottom: '20mm', left: '20mm', right: '20mm' },
  });

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
