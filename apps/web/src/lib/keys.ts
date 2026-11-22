/** True when a keystroke belongs to a text field (single-key shortcuts must yield). */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes(
      type,
    );
  }
  return tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** ⌘ on Apple platforms, Ctrl elsewhere. */
export const MOD_KEY_LABEL =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
