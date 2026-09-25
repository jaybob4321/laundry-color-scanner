/**
 * Searchable single-choice list of canonical colors (radio buttons), with
 * optional extra choices such as "Unknown" or "Pattern / multicolor".
 */
import { searchColors } from '../references.js';
import { h, swatch } from './dom.js';

let pickerCount = 0;

export function createColorPicker({ palette, selected = null, extras = [], onChange, label = 'Actual color' }) {
  const id = `picker-${++pickerCount}`;
  const name = `${id}-choice`;
  let value = selected;
  const search = h('input', {
    type: 'search',
    id: `${id}-search`,
    placeholder: 'Search colors (e.g. navy, grey, wine)',
    autocomplete: 'off',
    'aria-controls': `${id}-list`,
  });
  const list = h('div', { class: 'picker-list', id: `${id}-list`, role: 'radiogroup', 'aria-labelledby': `${id}-label` });

  function option(optionValue, title, detail, rgb) {
    const input = h('input', { type: 'radio', name, value: optionValue });
    input.checked = optionValue === value;
    input.addEventListener('change', () => {
      value = optionValue;
      onChange?.(value);
    });
    return h(
      'label',
      { class: 'picker-option' },
      input,
      rgb ? swatch(rgb) : h('span', { class: 'swatch', style: { background: 'repeating-linear-gradient(45deg, #888 0 6px, #ddd 6px 12px)' }, 'aria-hidden': 'true' }),
      h('span', {}, h('strong', { text: title }), detail ? h('small', { text: detail }) : null),
    );
  }

  function render() {
    const query = search.value;
    const matches = searchColors(palette, query);
    const items = [];
    const q = query.trim().toLowerCase();
    for (const extra of extras) {
      if (!q || extra.label.toLowerCase().includes(q)) items.push(option(extra.value, extra.label, extra.detail, null));
    }
    for (const color of matches) items.push(option(color.id, color.name, color.aliases.join(', '), color.rgb));
    list.replaceChildren(...(items.length ? items : [h('p', { class: 'picker-empty', text: 'No matching colors.' })]));
  }

  search.addEventListener('input', render);
  render();

  const element = h(
    'div',
    { class: 'picker' },
    h('label', { class: 'field-label', id: `${id}-label`, for: `${id}-search`, text: label }),
    search,
    list,
  );
  return {
    element,
    get value() {
      return value;
    },
    set value(v) {
      value = v;
      render();
    },
    focus() {
      search.focus();
    },
  };
}
