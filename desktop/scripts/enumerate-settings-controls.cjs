// Enumerate every settings-ish control on the RUNNING Control UI, with its class
// names and where it actually sits on screen.
//
// The question is narrow and so is this: which control, if any, sits at the TOP
// RIGHT of the page, and is it OURS (the injected affordance, marked
// data-claw-app-settings) or upstream's? A control that is ours and a control
// that is upstream's have different fixes, and a control that does not exist in
// the page at all means the one being reported is drawn by the client instead.
//
//   npx electron scripts/enumerate-settings-controls.js [url]

const { app, BrowserWindow } = require('electron');

const URL_ARG = process.argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:19099/';

app.whenReady().then(async () => {
  // A watchdog, because the failure mode this had first was silence: an exception
  // inside the evaluated script rejects the evaluate promise, nothing prints, and
  // the process sits there holding a window until someone notices. A probe that
  // cannot fail loudly reports "no controls found" for a page full of them.
  const watchdog = setTimeout(() => { console.log('TIMED OUT before the page could be read'); app.exit(2); }, 45000);
  process.on('unhandledRejection', (error) => {
    console.log(`UNHANDLED: ${String(error)}`);
    clearTimeout(watchdog);
    app.exit(3);
  });

  const win = new BrowserWindow({ show: false, width: 1280, height: 900 });
  await win.loadURL(URL_ARG);
  await new Promise((r) => setTimeout(r, 8000));

  const found = await win.webContents.executeJavaScript(`(() => {
    const out = [];
    try {
      const seen = new Set();
      const all = document.querySelectorAll('[class*=settings], [aria-label*=settings i], [title*=settings i], [data-claw-app-settings]');
      for (const el of all) {
        try {
          // The nearest thing a reader would press, so a wrapper and its button are
          // reported once rather than twice.
          const pressable = el.closest('button, a, [role=button]') || el;
          if (seen.has(pressable)) continue;
          seen.add(pressable);
          const r = pressable.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          const ours = pressable.hasAttribute('data-claw-app-settings') || pressable.closest('[data-claw-app-settings]') !== null;
          out.push({
            tag: pressable.tagName.toLowerCase(),
            cls: String(pressable.getAttribute('class') || '').slice(0, 70),
            label: (pressable.getAttribute('aria-label') || pressable.getAttribute('title') || pressable.textContent || '').trim().slice(0, 40),
            x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
            ours,
          });
        } catch (inner) { /* one unreadable node is not the answer */ }
      }
    } catch (e) { return { error: String(e), found: [] }; }
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      route: location.pathname + location.search,
      found: out,
    };
  })()`);

  clearTimeout(watchdog);
  if (found.error) console.log(`the page could not be read: ${found.error}`);

  console.log(`route: ${found.route}  viewport: ${found.viewport.w}x${found.viewport.h}`);
  if (!found.found.length) console.log('no settings-ish control found in the page at all');
  for (const c of found.found) {
    const where = c.y < 80 ? 'TOP' : (c.y > (found.viewport ? found.viewport.h : 900) - 140 ? 'BOTTOM' : 'middle');
    const side = c.x + c.w / 2 > (found.viewport ? found.viewport.w : 1280) / 2 ? 'right' : 'left';
    console.log(`  ${c.ours ? 'OURS    ' : 'upstream'} ${where.padEnd(6)} ${side.padEnd(5)} x=${String(c.x).padEnd(5)} y=${String(c.y).padEnd(5)} ${c.w}x${c.h}  <${c.tag} class="${c.cls}"> label="${c.label}"`);
  }
  app.exit(0);
});
