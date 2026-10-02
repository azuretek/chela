'use strict';

// The title strip's window controls, on Windows.
//
// The strip's preload exposes `chelaWindowControls`; where there is none (macOS
// keeps its traffic lights, and Linux has no strip) there is nothing to wire and
// this returns. The three clicks go straight back to the window through the
// bridge, and the maximise button follows the window's own state so it shows the
// restore glyph when the window is maximised.
(function () {
  const controls = window.chelaWindowControls;
  if (!controls) return;

  const byId = (id) => document.getElementById(id);
  const minimize = byId('minimize');
  const maximize = byId('maximize');
  const close = byId('close');

  minimize.addEventListener('click', () => controls.minimize());
  maximize.addEventListener('click', () => controls.toggleMaximize());
  close.addEventListener('click', () => controls.close());

  const showMaximized = (isMaximized) => {
    const label = isMaximized ? 'Restore' : 'Maximise';
    maximize.dataset.maximized = isMaximized ? 'true' : 'false';
    maximize.setAttribute('aria-label', label);
    maximize.setAttribute('title', label);
  };
  controls.onMaximizedChange(showMaximized);
  Promise.resolve(controls.isMaximized()).then(showMaximized).catch(() => {});
}());
