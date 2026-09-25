import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rgbToLab, srgbToLinear, linearToSrgb, SRGB8_TO_LINEAR, labToRgb, labToLinearRgb,
  hexToRgb, rgbToHex, labHueDegrees, linearRgbToLab,
} from '../../src/color/srgb-lab.js';
import { assertClose, assertLabClose, loadPalette, loadJson } from '../helpers.mjs';

test('reference conversions from blueprint §17', () => {
  assertLabClose(rgbToLab([0, 0, 0]), [0, 0, 0], 1e-12, 'black');
  assertLabClose(rgbToLab([255, 255, 255]), [100, 0, 0], 1e-3, 'white');
  assertLabClose(rgbToLab([255, 0, 0]), [53.2408, 80.0925, 67.2032], 1e-3, 'red');
});

test('other primaries match published D65 values', () => {
  assertLabClose(rgbToLab([0, 255, 0]), [87.7347, -86.1827, 83.1793], 1e-3, 'green');
  assertLabClose(rgbToLab([0, 0, 255]), [32.2970, 79.1875, -107.8602], 1e-3, 'blue');
});

test('linearization lookup table equals the piecewise formula', () => {
  for (let v = 0; v < 256; v++) assert.equal(SRGB8_TO_LINEAR[v], srgbToLinear(v / 255));
  assert.equal(SRGB8_TO_LINEAR[0], 0);
  assert.equal(SRGB8_TO_LINEAR[255], 1);
});

test('sRGB encode/decode are inverses', () => {
  for (let i = 0; i <= 1000; i++) {
    const c = i / 1000;
    assertClose(linearToSrgb(srgbToLinear(c)), c, 1e-12);
  }
});

test('Lab -> RGB round-trips every 8-bit gray and a grid of colors', () => {
  for (let v = 0; v < 256; v++) assert.deepEqual(labToRgb(rgbToLab([v, v, v])), [v, v, v]);
  for (let r = 0; r < 256; r += 17) {
    for (let g = 0; g < 256; g += 17) {
      for (let b = 0; b < 256; b += 17) assert.deepEqual(labToRgb(rgbToLab([r, g, b])), [r, g, b]);
    }
  }
});

test('non-integer RGB uses the exact formula', () => {
  const lab = rgbToLab([127.5, 127.5, 127.5]);
  const lin = srgbToLinear(0.5);
  assertLabClose(lab, linearRgbToLab(lin, lin, lin), 1e-12);
});

test('Lab -> linear RGB inverse keeps precision', () => {
  const lab = [41.21788, 25.66366, -22.87006];
  const [r, g, b] = labToLinearRgb(lab);
  assertLabClose(linearRgbToLab(r, g, b), lab, 1e-9);
});

test('hex helpers', () => {
  assert.deepEqual(hexToRgb('#202E4D'), [32, 46, 77]);
  assert.deepEqual(hexToRgb('ff0000'), [255, 0, 0]);
  assert.equal(rgbToHex([32, 46, 77]), '#202E4D');
  assert.equal(rgbToHex([300, -4, 0.4]), '#FF0000');
  assert.throws(() => hexToRgb('#12345'));
});

test('hue angle normalization', () => {
  assert.equal(labHueDegrees([50, 0, 0]), 0);
  assertClose(labHueDegrees([50, 1, 0]), 0, 1e-12);
  assertClose(labHueDegrees([50, 0, -1]), 270, 1e-12);
  assertClose(labHueDegrees([50, -1, -1e-12]), 180, 1e-9);
});

test('every palette entry: rgb matches hex and lab matches conversion (5 dp)', () => {
  const palette = loadPalette();
  assert.equal(palette.colorSpace, 'CIELAB-D65-2deg');
  for (const color of palette.colors) {
    assert.deepEqual(color.rgb, hexToRgb(color.hex), `${color.id} rgb`);
    const lab = rgbToLab(color.rgb).map((v) => +v.toFixed(5));
    assert.deepEqual(color.lab, lab, `${color.id} lab`);
  }
});

test('runtime palette is an exact copy of the authoritative spec palette', () => {
  assert.deepEqual(loadJson('data/colors.json'), loadJson('spec/colors.json'));
});
