/**
 * Minimal DOM helpers. All text goes through textContent — never innerHTML —
 * so user notes, imported data and AI text can't inject markup.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

// 24x24 stroke icons (paths only; rendered via createElementNS).
const ICONS = {
  camera: ['M3 8a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
  image: ['M4 5h16v14H4z', 'M4 16l5-5 4 4 3-3 4 4', 'M15.5 9.5h.01'],
  lock: ['M6 11h12v9H6z', 'M8 11V8a4 4 0 0 1 8 0v3'],
  settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
  upload: ['M12 20V9', 'M7 14l5-5 5 5', 'M5 4h14'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  flash: ['M13 2L4 14h7l-1 8 9-12h-7z'],
  calibrate: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 3v18', 'M12 7a5 5 0 0 1 0 10'],
  back: ['M15 18l-6-6 6-6'],
  home: ['M4 11l8-7 8 7', 'M6 10v10h12V10'],
  crop: ['M6 2v14a2 2 0 0 0 2 2h14', 'M2 6h14a2 2 0 0 1 2 2v14'],
  edit: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
  check: ['M5 12l5 5 9-10'],
  info: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 11v6', 'M12 7.5h.01'],
  alert: ['M12 3l10 18H2z', 'M12 10v5', 'M12 18h.01'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
  plus: ['M12 5v14', 'M5 12h14'],
  basket: ['M4 9h16l-2 11H6z', 'M8 9l4-5 4 5', 'M9 13v4', 'M15 13v4'],
  sparkle: ['M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z', 'M19 16l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z'],
};

export function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of ICONS[name] ?? ICONS.info) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/** Prepend icons to every element carrying data-icon (once). */
export function decorateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.dataset.iconDone) continue;
    el.prepend(icon(el.dataset.icon));
    el.dataset.iconDone = '1';
  }
}

/**
 * h('button', { class: 'btn', type: 'button', onClick: fn, 'aria-label': 'x' }, 'text', child)
 * `text` sets textContent; `dataset`/`style` accept objects; `on*` add listeners.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const $ = (selector, root = document) => root.querySelector(selector);

export function clear(el) {
  el.replaceChildren();
  return el;
}

export function swatch(rgb, { small = false, label } = {}) {
  return h('span', {
    class: small ? 'swatch swatch--sm' : 'swatch',
    style: { background: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` },
    'aria-hidden': label ? undefined : 'true',
    role: label ? 'img' : undefined,
    'aria-label': label,
  });
}

let announceTimer = 0;
/** Polite screen-reader announcement. */
export function announce(text) {
  const el = document.getElementById('announcer');
  if (!el) return;
  el.textContent = '';
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => (el.textContent = text), 60);
}

let toastTimer = 0;
export function toast(text, { timeout = 4500 } = {}) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), timeout);
}

/**
 * Modal confirmation using the native <dialog>. Resolves true on confirm.
 * `body` may be a string or a Node.
 */
export function confirmDialog({ title, body, confirmText = 'OK', cancelText = 'Cancel', danger = false, hideCancel = false }) {
  const dialog = document.getElementById('dialog');
  const confirm = document.getElementById('dialog-confirm');
  const cancel = document.getElementById('dialog-cancel');
  document.getElementById('dialog-title').textContent = title;
  const bodyEl = clear(document.getElementById('dialog-body'));
  for (const part of [].concat(body ?? [])) bodyEl.append(part instanceof Node ? part : h('p', { text: part }));
  confirm.textContent = confirmText;
  confirm.className = `btn ${danger ? 'btn--danger' : 'btn--primary'}`;
  cancel.textContent = cancelText;
  cancel.hidden = hideCancel;
  return new Promise((resolve) => {
    const opener = document.activeElement;
    dialog.returnValue = '';
    dialog.addEventListener(
      'close',
      () => {
        resolve(dialog.returnValue === 'confirm');
        if (opener && typeof opener.focus === 'function') opener.focus();
      },
      { once: true },
    );
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else resolve(window.confirm(`${title}\n\n${typeof body === 'string' ? body : ''}`));
  });
}
