import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Exit animations delay unmount until CSS keyframes finish. In jsdom (where
 * Element.prototype.getAnimations does not exist) or when the user prefers
 * reduced motion, we unmount immediately so synchronous tests and accessible
 * preferences never wait on animations.
 */
export function canAnimateMotion(): boolean {
  return (
    !prefersReducedMotion() &&
    typeof Element !== 'undefined' &&
    typeof Element.prototype.getAnimations === 'function'
  );
}

export const MODAL_EXIT_MS = 180;
export const SHEET_EXIT_MS = 220;
export const TOAST_EXIT_MS = 160;

interface SwipeDismissOptions {
  enabled: boolean;
  onDismiss: () => void;
  thresholdPx?: number;
}

export function useSheetSwipeDismiss({
  enabled,
  onDismiss,
  thresholdPx = 80,
}: SwipeDismissOptions) {
  const [dragY, setDragY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{
    active: boolean;
    pointerId: number;
    startY: number;
    lastY: number;
  } | null>(null);

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || (event.button !== undefined && event.button !== 0)) return;
    if (typeof window !== 'undefined' && window.innerWidth > 767) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, select, textarea')) return;

    dragRef.current = {
      active: true,
      pointerId: event.pointerId,
      startY: event.clientY,
      lastY: 0,
    };
    setIsDragging(true);
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic pointer events in tests may not support capture
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const st = dragRef.current;
    if (!st || !st.active || st.pointerId !== event.pointerId) return;
    const dy = Math.max(0, event.clientY - st.startY);
    st.lastY = dy;
    setDragY(dy);
  };

  const finishDrag = (event: ReactPointerEvent<HTMLElement>, commit: boolean) => {
    const st = dragRef.current;
    if (!st || !st.active || st.pointerId !== event.pointerId) return;
    const dy = st.lastY;
    dragRef.current = null;
    setIsDragging(false);
    setDragY(0);
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Ignore release failures on synthetic events
    }
    if (commit && dy >= thresholdPx) {
      onDismiss();
    }
  };

  const swipeStyle =
    isDragging && dragY > 0 ? { transform: `translateY(${dragY}px)` } : undefined;

  return {
    isDragging,
    swipeStyle,
    swipeHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (e: ReactPointerEvent<HTMLElement>) => finishDrag(e, true),
      onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => finishDrag(e, false),
    },
  };
}
