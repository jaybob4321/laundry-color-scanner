/**
 * Movable, resizable region over an image box. Pointer drag moves it, the
 * corner handle resizes it, and the keyboard works too: arrow keys move,
 * Shift+arrow keys resize. Coordinates are normalized to the image.
 */
import { clampRoi } from '../geometry.js';
import { h } from './dom.js';

const KEY_STEP = 0.02;

export class RegionEditor {
  #roi;
  #drag = null;

  /**
   * @param {object} o
   * @param {HTMLElement} o.container  positioned box exactly covering the image
   * @param {{width:number,height:number}} o.imageSize  image pixels (for limits)
   */
  constructor({ container, imageSize, roi, kind, label, description, minPx, maxAspect, onChange }) {
    this.container = container;
    this.imageSize = imageSize;
    this.minPx = minPx;
    this.maxAspect = maxAspect;
    this.onChange = onChange;
    this.label = label;
    this.handle = h('span', { class: 'region-handle', 'aria-hidden': 'true' });
    this.el = h(
      'div',
      {
        class: `region region--${kind}`,
        tabindex: '0',
        role: 'group',
        'aria-roledescription': 'adjustable region',
        'aria-description': description,
      },
      h('span', { class: 'region-label', text: label, 'aria-hidden': 'true' }),
      this.handle,
    );
    this.el.addEventListener('pointerdown', (e) => this.#onPointerDown(e));
    this.el.addEventListener('pointermove', (e) => this.#onPointerMove(e));
    this.el.addEventListener('pointerup', (e) => this.#onPointerUp(e));
    this.el.addEventListener('pointercancel', (e) => this.#onPointerUp(e));
    this.el.addEventListener('keydown', (e) => this.#onKey(e));
    container.append(this.el);
    this.set(roi, { silent: true });
  }

  get roi() {
    return { ...this.#roi };
  }

  set(roi, { silent = false } = {}) {
    this.#roi = clampRoi(roi, this.imageSize.width, this.imageSize.height, { minPx: this.minPx, maxAspect: this.maxAspect });
    const r = this.#roi;
    Object.assign(this.el.style, {
      left: `${r.x * 100}%`,
      top: `${r.y * 100}%`,
      width: `${r.width * 100}%`,
      height: `${r.height * 100}%`,
    });
    const pct = (v) => Math.round(v * 100);
    this.el.setAttribute(
      'aria-label',
      `${this.label}: ${pct(r.x)}% from left, ${pct(r.y)}% from top, ${pct(r.width)}% wide, ${pct(r.height)}% tall`,
    );
    if (!silent) this.onChange?.(this.roi);
  }

  remove() {
    this.el.remove();
  }

  #point(e) {
    const box = this.container.getBoundingClientRect();
    return { x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height };
  }

  #onPointerDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    this.el.focus({ preventScroll: true });
    this.el.setPointerCapture(e.pointerId);
    this.#drag = { mode: e.target === this.handle ? 'resize' : 'move', start: this.#point(e), roi: this.roi, pointerId: e.pointerId };
  }

  #onPointerMove(e) {
    const drag = this.#drag;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const p = this.#point(e);
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    if (drag.mode === 'move') this.set({ ...drag.roi, x: drag.roi.x + dx, y: drag.roi.y + dy });
    else this.set({ ...drag.roi, width: drag.roi.width + dx, height: drag.roi.height + dy });
  }

  #onPointerUp(e) {
    if (this.#drag?.pointerId === e.pointerId) this.#drag = null;
  }

  #onKey(e) {
    const deltas = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const d = deltas[e.key];
    if (!d) return;
    e.preventDefault();
    const r = this.roi;
    const step = e.altKey ? KEY_STEP / 4 : KEY_STEP;
    if (e.shiftKey) this.set({ ...r, width: r.width + d[0] * step, height: r.height + d[1] * step });
    else this.set({ ...r, x: r.x + d[0] * step, y: r.y + d[1] * step });
  }
}

/** Numeric fallback fields (percent) bound to a RegionEditor. */
export function numericFields(editor, legend) {
  const inputs = {};
  const fields = [
    ['x', 'Left %'],
    ['y', 'Top %'],
    ['width', 'Width %'],
    ['height', 'Height %'],
  ].map(([key, text]) => {
    const input = h('input', { type: 'number', min: '0', max: '100', step: '1', inputmode: 'numeric' });
    input.addEventListener('change', () => {
      const values = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, Number(el.value) / 100]));
      if (Object.values(values).every(Number.isFinite)) editor.set(values);
    });
    inputs[key] = input;
    return h('label', { class: 'small-label' }, text, input);
  });
  const sync = (roi) => {
    for (const [k, el] of Object.entries(inputs)) el.value = String(Math.round(roi[k] * 100));
  };
  sync(editor.roi);
  return { element: h('fieldset', {}, h('legend', { text: legend }), ...fields), sync };
}
