// Spec value formats and label truncation used by stat and bar/line widgets.

import { describe, expect, it } from 'vitest';
import { fmtField, fmtFormat, isEmptyWidget, truncateLabel } from '@/session/dashboards/data';

describe('isEmptyWidget', () => {
  const base = { id: 'w', title: '', span: 2 };
  it('treats no rows, or a null stat value, as empty', () => {
    const pie = { ...base, type: 'pie' as const, label: 'speaker', value: 'seconds' };
    expect(isEmptyWidget(pie, [])).toBe(true);
    expect(isEmptyWidget(pie, [{ speaker: 'A', seconds: 3 }])).toBe(false);
    const stat = { ...base, type: 'stat' as const, field: 'wpm' };
    expect(isEmptyWidget(stat, [{ words: 0, wpm: null }])).toBe(true);
    expect(isEmptyWidget(stat, [])).toBe(true);
    expect(isEmptyWidget(stat, [{ wpm: 0 }])).toBe(false);
    expect(isEmptyWidget({ ...base, type: 'stat', value: 12 }, [])).toBe(false);
  });
});

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

describe('fmtField', () => {
  it('uses the spec format when given, else the field-name default', () => {
    expect(fmtField(2529, 'seconds', 'minutes')).toBe(fmtFormat(2529, 'minutes'));
    expect(fmtField(125, 'atSec', 'duration')).toBe('2:05');
    expect(fmtField(125, 'atSec')).toBe('2:05');
    expect(fmtField(125, 'count')).toBe(new Intl.NumberFormat().format(125));
  });
});
