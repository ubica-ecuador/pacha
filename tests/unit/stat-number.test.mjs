// parseStatNumber, in isolation: the number a stat panel's text shows,
// understanding thousands separators and Grafana's `short`-unit suffixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatNumber } from '../lib/browser.mjs';

test('a plain integer', () => {
  assert.equal(parseStatNumber('10718'), 10718);
});

test('a thousands separator', () => {
  assert.equal(parseStatNumber('10,718'), 10718);
});

test('the K suffix', () => {
  assert.equal(parseStatNumber('10.7 K'), 10700);
});

test('the Mil suffix', () => {
  assert.equal(parseStatNumber('63.5 Mil'), 63500000);
});

test('the Bil suffix', () => {
  assert.equal(parseStatNumber('1.2 Bil'), 1200000000);
});

test('a negative number', () => {
  assert.equal(parseStatNumber('-3.5'), -3.5);
});

test('a plain decimal', () => {
  assert.equal(parseStatNumber('7.2'), 7.2);
});

test('no number at all throws', () => {
  assert.throws(() => parseStatNumber('No data'));
});
