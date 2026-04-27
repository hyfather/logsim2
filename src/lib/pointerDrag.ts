/**
 * Pointer-driven drag helper that works for mouse, touch, and pen input.
 *
 * Pass an `onDown` PointerEvent and a `onMove` callback that receives the
 * delta from the start position; the helper takes care of pointer capture,
 * preventing the page from scrolling during the gesture, and cleaning up
 * listeners on release. Returns immediately if the event isn't a primary
 * left-click / single-touch.
 */
export interface DragMoveEvent {
  /** Pixel delta from the pointerdown position. */
  dx: number
  dy: number
  /** The current pointer event (use for clientX/Y if you need absolute pos). */
  event: PointerEvent
}

export interface StartPointerDragOptions {
  onMove: (e: DragMoveEvent) => void
  onEnd?: (e: DragMoveEvent) => void
  /** When true (default) the helper calls preventDefault on pointermove so the
   *  page doesn't scroll while dragging on touch. */
  preventScroll?: boolean
}

export function startPointerDrag(
  downEvent: React.PointerEvent | PointerEvent,
  opts: StartPointerDragOptions,
): void {
  // Ignore secondary buttons (right-click etc) and non-primary touches.
  if ('button' in downEvent && downEvent.button !== 0) return
  if ('isPrimary' in downEvent && downEvent.isPrimary === false) return

  const startX = downEvent.clientX
  const startY = downEvent.clientY
  const target = downEvent.currentTarget as Element | null
  const pointerId = downEvent.pointerId

  // Capture so we keep getting move events even when the pointer leaves the
  // element (essential for fast drags).
  if (target && 'setPointerCapture' in target) {
    try { (target as Element & { setPointerCapture(id: number): void }).setPointerCapture(pointerId) } catch {}
  }

  const preventScroll = opts.preventScroll !== false

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return
    if (preventScroll && ev.cancelable) ev.preventDefault()
    opts.onMove({ dx: ev.clientX - startX, dy: ev.clientY - startY, event: ev })
  }

  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    opts.onEnd?.({ dx: ev.clientX - startX, dy: ev.clientY - startY, event: ev })
  }

  window.addEventListener('pointermove', onMove, { passive: false })
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
}
