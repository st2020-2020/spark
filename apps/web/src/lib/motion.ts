import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

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

// Exit timers must outlast the matching CSS exit animation (tokens.css): fast = 160ms,
// normal = 240ms. Sheets leave with --sp-dur-normal on phones, so they wait for that.
export const MODAL_EXIT_MS = 180;
export const SHEET_EXIT_MS = 240;
export const TOAST_EXIT_MS = 160;
export const POPOVER_EXIT_MS = 140;

/** Reads a motion token from tokens.css so script-driven animations share the CSS language. */
function motionToken(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function motionMs(name: string, fallback: number): number {
  const parsed = Number.parseFloat(motionToken(name, `${fallback}ms`));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Keeps a conditionally rendered element mounted while it plays its exit animation.
 * `closing` is true during the exit window so CSS can run the `.is-closing` keyframes.
 * Re-opening during the exit cancels it and the element simply stays.
 */
export function usePresence(open: boolean, exitMs = POPOVER_EXIT_MS) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    if (!canAnimateMotion()) {
      setMounted(false);
      setClosing(false);
      return;
    }
    setClosing(true);
    const timer = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, exitMs);
    return () => window.clearTimeout(timer);
  }, [open, mounted, exitMs]);
  return { mounted: open || mounted, closing: !open && closing };
}

/**
 * FLIP for lists: when the set of `[data-flip-key]` children changes, items that stay glide
 * from their old place, and new items settle in, so inserts, removals and filter changes read
 * as movement instead of a jump. Only transform/opacity animate, only on-screen items are
 * touched, and nested flip keys are not supported (put keys on one level only).
 */
export function useFlipList(
  containerRef: RefObject<HTMLElement | null>,
  signature: string,
  { animateEnter = true }: { animateEnter?: boolean } = {},
) {
  const positionsRef = useRef<Map<string, number>>(new Map());

  // Layout positions, not painted ones: offsetTop ignores transforms, so an item that is
  // still mid-animation (entering, gliding, the "fresh" glow) is measured where it really sits.
  // Sticky items opt into measuring their non-sticky parent with data-flip-measure="parent".
  const layoutTop = (node: HTMLElement) => {
    let top = 0;
    let el: HTMLElement | null = node;
    while (el) {
      top += el.offsetTop;
      el = el.offsetParent as HTMLElement | null;
    }
    return top;
  };

  const snapshot = () => {
    const root = containerRef.current;
    const next = new Map<string, number>();
    if (!root) return next;
    const rootTop = layoutTop(root);
    root.querySelectorAll<HTMLElement>('[data-flip-key]').forEach((node) => {
      const key = node.dataset.flipKey;
      const measured =
        node.dataset.flipMeasure === 'parent' && node.parentElement ? node.parentElement : node;
      if (key) next.set(key, layoutTop(measured) - rootTop);
    });
    return next;
  };

  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const previous = positionsRef.current;
    const next = snapshot();
    positionsRef.current = next;
    if (previous.size === 0 || !canAnimateMotion()) return;

    const duration = motionMs('--sp-dur-normal', 240);
    const move = motionToken('--sp-ease-move', 'cubic-bezier(0.32, 0.72, 0.24, 1)');
    const arrive = motionToken('--sp-ease-out', 'cubic-bezier(0.22, 1, 0.36, 1)');
    const rootTop = root.getBoundingClientRect().top;
    const viewport = window.innerHeight;
    root.querySelectorAll<HTMLElement>('[data-flip-key]').forEach((node) => {
      const key = node.dataset.flipKey;
      if (!key) return;
      const top = next.get(key);
      if (top === undefined) return;
      const screenTop = rootTop + top;
      if (screenTop > viewport + 120 || screenTop + node.offsetHeight < -120) return;
      const before = previous.get(key);
      if (before === undefined) {
        // Some lists (toasts) already have their own entrance; only reflow the rest.
        if (!animateEnter) return;
        node.animate(
          [
            { opacity: 0, transform: 'translateY(-6px) scale(0.985)' },
            { opacity: 1, transform: 'none' },
          ],
          { duration, easing: arrive },
        );
        return;
      }
      const delta = before - top;
      if (Math.abs(delta) < 1 || Math.abs(delta) > viewport) return;
      node.animate([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], {
        duration,
        easing: move,
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  // Content can change height without a key change (an image loads, a card expands). Keep the
  // remembered positions current so the next real change starts from where things actually are.
  useEffect(() => {
    const root = containerRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      positionsRef.current = snapshot();
    });
    observer.observe(root);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * Sliding selection for segmented controls: writes the active segment's offset and width to
 * CSS variables so a single indicator glides between options instead of colours snapping.
 */
export function useSegmentIndicator(
  containerRef: RefObject<HTMLElement | null>,
  activeKey: string | number | boolean | undefined,
) {
  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const place = () => {
      const active = root.querySelector<HTMLElement>(
        '[aria-pressed="true"], [aria-selected="true"], .active',
      );
      if (!active) {
        root.style.setProperty('--seg-w', '0px');
        return;
      }
      root.style.setProperty('--seg-x', `${active.offsetLeft}px`);
      root.style.setProperty('--seg-w', `${active.offsetWidth}px`);
      root.classList.add('has-seg-indicator');
    };
    place();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(place);
    observer.observe(root);
    return () => observer.disconnect();
  }, [containerRef, activeKey]);
}

/**
 * Loads the next page when the sentinel scrolls near the viewport, so long lists simply keep
 * going. The visible button stays as the keyboard and fallback path.
 */
export function useAutoLoadMore(
  sentinelRef: RefObject<HTMLElement | null>,
  { enabled, onLoad }: { enabled: boolean; onLoad: () => void },
) {
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !enabled || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadRef.current();
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [sentinelRef, enabled]);
}

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
  const [settledAfterDrag, setSettledAfterDrag] = useState(false);
  const dragRef = useRef<{
    active: boolean;
    pointerId: number;
    startY: number;
    lastY: number;
  } | null>(null);

  const resetSwipe = () => {
    dragRef.current = null;
    setIsDragging(false);
    setDragY(0);
  };

  useEffect(() => {
    if (!enabled) {
      resetSwipe();
      setSettledAfterDrag(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      if (window.innerWidth > 767) {
        resetSwipe();
        setSettledAfterDrag(false);
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || (event.button !== undefined && event.button !== 0)) return;
    if (typeof window !== 'undefined' && window.innerWidth > 767) return;
    if (!Number.isFinite(event.clientY)) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, select, textarea')) return;

    dragRef.current = {
      active: true,
      pointerId: event.pointerId,
      startY: event.clientY,
      lastY: 0,
    };
    setSettledAfterDrag(true);
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
    if (!Number.isFinite(event.clientY)) return;
    const dy = Math.max(0, event.clientY - st.startY);
    st.lastY = dy;
    setDragY(dy);
  };

  const finishDrag = (event: ReactPointerEvent<HTMLElement>, commit: boolean) => {
    const st = dragRef.current;
    if (!st || !st.active || st.pointerId !== event.pointerId) return;
    const dy = st.lastY;
    resetSwipe();
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
    settledAfterDrag,
    swipeStyle,
    swipeHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (e: ReactPointerEvent<HTMLElement>) => finishDrag(e, true),
      onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => finishDrag(e, false),
      onLostPointerCapture: (e: ReactPointerEvent<HTMLElement>) => finishDrag(e, false),
    },
  };
}
