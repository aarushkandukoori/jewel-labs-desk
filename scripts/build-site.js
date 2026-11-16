// Builds the website into site-dist/ for GitHub Pages:   node scripts/build-site.js
//
//   site/                          the page, styles, scripts and images     ->  site-dist/
//   src/renderer/fonts/*.woff2     the fonts (self-hosted, no Google Fonts)  ->  site-dist/fonts/
//   src/renderer/fonts/OFL.txt     the fonts' license, which goes with them  ->  site-dist/fonts/
//   assets/logo.svg                the favicon                               ->  site-dist/favicon.svg
//   src/renderer/                  the real app UI, for the live demo        ->  site-dist/app/
//   samples/sample-shipment/       the fictional sample shipment, if built   ->  site-dist/app/samples/
//
// Then it:
//   - marks the "Watch it work" video as ready when site/media/demo.mp4 exists (until then the page
//     hides that section, and never asks for a file that is not there),
//   - warns when the app imports a file the website does not ship (the demo would break),
//   - checks the recorded run the live demo replays (app/demo/sample-run.json) and warns about any
//     file it points to that is missing,
//   - writes .nojekyll so GitHub Pages serves every file as it is.
// Every link in the site is relative, so it works at https://<user>.github.io/jewel-labs-desk/
// as well as from a local server. GitHub Pages runs on Linux, where "Demo.pdf" and "demo.pdf" are
// different files, so the checks compare names exactly (a Mac would say both exist).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The SIL Open Font License asks that every copy of the fonts carries the license, so it is copied with them.
const FONT_LICENSE = 'OFL.txt';

/**
 * Builds the site. `root` is the repository folder, `out` the folder to write (emptied first).
 * Returns a summary: { out, files, bytes, app: 'renderer', demo: 'recorded'|'none', demoSteps, samples,
 * video: 'ready'|'pending', fonts, warnings }.
 */
export function buildSite({ root = ROOT, out = path.join(root, 'site-dist'), log = console.log } = {}) {
  root = path.resolve(root);
  out = path.resolve(out);
  assertSafeOut(out, root);
  const from = (...parts) => path.join(root, ...parts);
  const to = (...parts) => path.join(out, ...parts);
  const summary = {
    out, files: 0, bytes: 0, app: 'renderer', demo: 'none', demoSteps: 0, samples: false, video: 'pending', fonts: 0, warnings: [],
  };
  const warn = (message) => {
    summary.warnings.push(message);
    log(`warning: ${message}`);
  };

  if (!fs.existsSync(from('site', 'index.html'))) throw new Error(`No site/index.html in ${root}`);
  // The live demo is the app's own screens; without them there is nothing to show.
  if (!fs.existsSync(from('src', 'renderer', 'index.html'))) throw new Error(`No src/renderer/index.html in ${root}: the live demo needs the app's screens.`);

  // 1. Start from an empty folder, so files deleted from site/ do not linger.
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  // 2. The website itself.
  copyDir(from('site'), out);

  // 3. Fonts, from the app's own copy, so the site and the app use the same files.
  const fontDir = from('src', 'renderer', 'fonts');
  if (fs.existsSync(fontDir)) {
    fs.mkdirSync(to('fonts'), { recursive: true });
    for (const name of fs.readdirSync(fontDir).filter((n) => n.endsWith('.woff2'))) {
      fs.copyFileSync(path.join(fontDir, name), to('fonts', name));
      summary.fonts++;
    }
    if (existsExactly(fontDir, path.join(fontDir, FONT_LICENSE))) {
      fs.copyFileSync(path.join(fontDir, FONT_LICENSE), to('fonts', FONT_LICENSE));
    } else if (summary.fonts) {
      warn(`src/renderer/fonts has no ${FONT_LICENSE}: the site would ship the fonts without their license.`);
    }
  } else {
    warn('src/renderer/fonts is missing: the site will fall back to system fonts.');
  }

  // 4. The favicon is the Jewel Labs logo.
  if (fs.existsSync(from('assets', 'logo.svg'))) fs.copyFileSync(from('assets', 'logo.svg'), to('favicon.svg'));
  else warn('assets/logo.svg is missing: no favicon.');

  // 5. The app UI for the live demo. Without window.jl (the Electron bridge) it runs on demo/mock-api.js.
  copyDir(from('src', 'renderer'), to('app'));
  for (const problem of checkAppImports(to('app'))) warn(problem);
  // The live demo replays the recorded run. Without one it shows an error banner.
  const run = checkDemoRun(to('app'));
  summary.demo = run.kind;
  summary.demoSteps = run.steps;
  for (const problem of run.problems) warn(problem);

  // 6. The fictional sample shipment the demo replays.
  const samplesDir = from('samples', 'sample-shipment');
  if (fs.existsSync(samplesDir)) {
    copyDir(samplesDir, to('app', 'samples'));
    summary.samples = true;
  }

  // 7. The walkthrough video: switch the section on only when the file is really there.
  if (fs.existsSync(from('site', 'media', 'demo.mp4'))) {
    let html = fs.readFileSync(to('index.html'), 'utf8');
    if (html.includes('data-video="pending"')) {
      html = html.replace('data-video="pending"', 'data-video="ready"');
      if (!fs.existsSync(from('site', 'media', 'demo-poster.jpg'))) {
        html = html.replace('data-video-poster="media/demo-poster.jpg"', 'data-video-poster=""');
      }
      fs.writeFileSync(to('index.html'), html);
      summary.video = 'ready';
    } else {
      warn('site/index.html has no data-video="pending" marker: the video section was left as it is.');
    }
  }

  // 8. Tell GitHub Pages not to run Jekyll, which would hide files and folders that start with "_".
  fs.writeFileSync(to('.nojekyll'), '');

  for (const file of listFiles(out)) {
    summary.files++;
    summary.bytes += fs.statSync(file).size;
  }
  return summary;
}

/** Refuses to empty a folder that is the disk root, the repository, a parent of it, or the source folders. */
function assertSafeOut(out, root) {
  const problems = [
    out === path.parse(out).root,
    out === root,
    root.startsWith(out + path.sep),
    out === path.join(root, 'site') || out.startsWith(path.join(root, 'site') + path.sep),
    out === path.join(root, 'src') || out.startsWith(path.join(root, 'src') + path.sep),
  ];
  if (problems.some(Boolean)) throw new Error(`Refusing to write the site into ${out}`);
}

/** Copies a folder, leaving out hidden files (.DS_Store, .gitkeep) and macOS __MACOSX folders. */
function copyDir(source, target) {
  fs.cpSync(source, target, {
    recursive: true,
    filter: (file) => {
      const name = path.basename(file);
      return file === source || (!name.startsWith('.') && name !== '__MACOSX');
    },
  });
}

/**
 * True when `file` exists under `base` with exactly this spelling, upper and lower case included.
 * GitHub Pages runs on Linux, which treats "Demo.pdf" and "demo.pdf" as different files.
 */
function existsExactly(base, file) {
  const rel = path.relative(base, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  let dir = base;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return false; // not a folder
    }
    if (!names.includes(part)) return false;
    dir = path.join(dir, part);
  }
  return true;
}

/** Every file under a folder, at any depth. */
function listFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full));
    else files.push(full);
  }
  return files;
}

// Ways a file can point at another file: JS imports, and script/stylesheet tags in HTML.
const REFERENCE_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g, // import x from '...'   export { x } from '...'
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // import('...')
  /\bimport\s+['"]([^'"]+)['"]/g, // import '...'
  /<script\b[^>]*\bsrc=["']([^"']+)["']/g,
  /<link\b[^>]*\bhref=["']([^"']+)["']/g,
];

/**
 * The website ships only the app folder. Lists every reference in the app's own code (not vendor/)
 * that leaves the app folder or points to a file that is not there, since the demo would break.
 */
export function checkAppImports(appDir) {
  const problems = [];
  const files = listFiles(appDir).filter((file) => {
    const rel = path.relative(appDir, file).split(path.sep);
    return rel[0] !== 'vendor' && rel[0] !== 'samples' && /\.(m?js|html)$/.test(file);
  });
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of REFERENCE_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const spec = match[1].split(/[?#]/)[0];
        if (!spec.startsWith('./') && !spec.startsWith('../') && !/^[\w-]+(\/[\w.-]+)*\.\w+$/.test(spec)) continue;
        const target = path.resolve(path.dirname(file), spec);
        const where = path.relative(appDir, file);
        if (target !== appDir && !target.startsWith(appDir + path.sep)) {
          problems.push(`app/${where} refers to ${spec}, which is outside the app folder the website ships.`);
        } else if (!existsExactly(appDir, target)) {
          problems.push(`app/${where} refers to ${spec}, which does not exist.`);
        }
      }
    }
  }
  return problems;
}

/**
 * The live demo replays app/demo/sample-run.json, the recorded run (steps). There is no other run to fall back
 * on: without a recording the demo shows an error banner. Returns { kind: 'recorded'|'none', steps, files,
 * problems }, where problems also lists every file the recording points to that the website does not ship.
 */
export function checkDemoRun(appDir) {
  const runFile = path.join(appDir, 'demo', 'sample-run.json');
  const result = { kind: 'none', steps: 0, files: 0, problems: [] };
  const banner = 'so the demo shows an error banner instead of the run';
  if (!fs.existsSync(runFile)) {
    result.problems.push(`app/demo/sample-run.json is missing, ${banner}.`);
    return result;
  }
  let run;
  try {
    run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  } catch (error) {
    result.problems.push(`app/demo/sample-run.json is not valid JSON (${error.message}), ${banner}.`);
    return result;
  }
  result.steps = Array.isArray(run.steps) ? run.steps.length : 0;
  if (!result.steps) {
    result.problems.push(`app/demo/sample-run.json has no recorded steps, ${banner}.`);
    return result;
  }
  result.kind = 'recorded';
  // File addresses are relative to sample-run.json; data: addresses carry the file inside them.
  for (const url of Object.values(run.files || {})) {
    if (typeof url !== 'string' || url.startsWith('data:')) continue;
    result.files++;
    let target;
    try {
      target = path.resolve(path.dirname(runFile), decodeURIComponent(url.split(/[?#]/)[0]));
    } catch {
      target = null;
    }
    if (!target || !existsExactly(appDir, target)) {
      result.problems.push(`app/demo/sample-run.json points to ${url}, which is not in the app folder the website ships.`);
    }
  }
  return result;
}

// Run from the command line.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const summary = buildSite();
  const mb = (summary.bytes / (1024 * 1024)).toFixed(1);
  const demo = summary.demo === 'recorded' ? `recorded run (${summary.demoSteps} steps)` : summary.demo;
  console.log(`Built ${path.relative(process.cwd(), summary.out) || summary.out}: ${summary.files} files, ${mb} MB.`);
  console.log(`  app: ${summary.app}   demo: ${demo}   samples: ${summary.samples ? 'yes' : 'no'}   video: ${summary.video}   fonts: ${summary.fonts}`);
  if (summary.warnings.length) console.log(`  ${summary.warnings.length} warning(s) above.`);
}
