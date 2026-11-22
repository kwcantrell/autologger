// Spec value formats and label truncation used by stat and bar/line widgets.

import { describe, expect, it } from 'vitest';
import { fmtFormat, truncateLabel } from '@/session/dashboards/data';

describe('fmtFormat', () => {
  it('shows seconds as a duration', () => {
    expect(fmtFormat(1339, 'duration')).toBe('22:19');
    expect(fmtFormat(3725.6, 'duration')).toBe('1:02:05');
    expect(fmtFormat('59', 'duration')).toBe('0:59');
  });

  it('shows seconds as minutes with one decimal', () => {
    expect(fmtFormat(90, 'minutes')).toBe(
      new Intl.NumberFormat(undefined, { minimumFractionDigits: 1 }).format(1.5),
    );
    expect(fmtFormat(600, 'minutes')).toBe(
      new Intl.NumberFormat(undefined, { minimumFractionDigits: 1 }).format(10),
    );
  });

  it('shows ratios as percentages and plain numbers', () => {
    expect(fmtFormat(0.25, 'percent')).toBe(
      new Intl.NumberFormat(undefined, { style: 'percent' }).format(0.25),
    );
    expect(fmtFormat(1234.5, 'number')).toBe(new Intl.NumberFormat().format(1234.5));
  });

  it('falls back to text for non-numeric values', () => {
    expect(fmtFormat('n/a', 'duration')).toBe('n/a');
    expect(fmtFormat(null, 'minutes')).toBe('—');
  });
});

describe('truncateLabel', () => {
  it('keeps short labels and cuts long ones with an ellipsis', () => {
    expect(truncateLabel('Intro', 10)).toBe('Intro');
    expect(truncateLabel('A very long chapter title', 10)).toBe('A very lo…');
    expect(truncateLabel('A very long chapter title', 10).length).toBeLessThanOrEqual(10);
    expect(truncateLabel('Anything', undefined)).toBe('Anything');
  });
});
