import type { KeyboardEvent } from 'react';

/** Supports ArrowDown/ArrowUp/Home/End navigation across enabled menuitems. */
export function handleMenuKeyDown(event: KeyboardEvent<HTMLElement>): void {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(event.key)) return;

  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'),
  );
  if (items.length === 0) return;

  event.preventDefault();
  const currentIdx = items.indexOf(document.activeElement as HTMLElement);

  let nextIdx = 0;
  if (event.key === 'ArrowDown') {
    nextIdx = currentIdx < 0 ? 0 : (currentIdx + 1) % items.length;
  } else if (event.key === 'ArrowUp') {
    nextIdx = currentIdx <= 0 ? items.length - 1 : currentIdx - 1;
  } else if (event.key === 'End') {
    nextIdx = items.length - 1;
  }

  items[nextIdx]?.focus();
}
