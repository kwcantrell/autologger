import { describe, expect, it } from 'vitest';
import { currentRowErrors, withRowError } from './rowErrors';

describe('change-log row errors', () => {
  it('keep an undo error while the list is unchanged and drop it once the list changes', () => {
    const before = [{ id: 'chg_1' }];
    const failed = withRowError({ list: before, errors: {} }, before, 'chg_1', 'Changed again');
    expect(currentRowErrors(failed, before)).toEqual({ chg_1: 'Changed again' });
    // The newer change was undone elsewhere: the list refetched with new rows.
    const after = [{ id: 'chg_2' }, { id: 'chg_1' }];
    expect(currentRowErrors(failed, after)).toEqual({});
    // A later failure starts from that list, without the stale entry.
    expect(withRowError(failed, after, 'chg_2', 'No')).toEqual({
      list: after,
      errors: { chg_2: 'No' },
    });
    expect(withRowError(failed, before, 'chg_1', undefined).errors).toEqual({});
  });
});
