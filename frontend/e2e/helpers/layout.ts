import { expect, type ElementHandle, type Locator } from '@playwright/test';

/** Bounding-box top of a locator, with an explicit failure when it has no box. */
export async function elementTop(locator: Locator, label: string): Promise<number> {
  const box = await locator.boundingBox();
  expect(box, `${label} has bounds`).not.toBeNull();
  return box!.y;
}

/** A pinning control keeps its viewport position while the content region scrolls. */
export function expectPinned(after: number, before: number, label: string): void {
  expect(
    Math.abs(after - before),
    `${label} keeps its viewport position while the content region scrolls`,
  ).toBeLessThanOrEqual(1);
}

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Drives a scroll container to its end and reports the resulting metrics. */
export async function scrollToEnd(locator: Locator): Promise<ScrollMetrics> {
  return locator.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    };
  });
}

/**
 * The closest ancestor that actually scrolls the target, falling back to the
 * document scroller. Lets a spec assert which region owns the scroll without
 * pinning a markup class.
 */
export async function innermostScrollableAncestor(locator: Locator): Promise<ElementHandle<HTMLElement>> {
  const handle = await locator.evaluateHandle((element) => {
    let node: HTMLElement | null = element.parentElement;
    while (node) {
      if (node.scrollHeight > node.clientHeight + 1) return node;
      node = node.parentElement;
    }
    return document.scrollingElement as HTMLElement;
  });
  const scroller = handle.asElement() as ElementHandle<HTMLElement> | null;
  expect(scroller, 'the target has a vertical scroll owner').not.toBeNull();
  return scroller!;
}
