'use strict';

/**
 * Showcase Cursor and Interaction Overlay.
 * Injects a visual pointer and click wave into the DOM for natural, polished screencasts.
 */

const CURSOR_INIT_SCRIPT = `
(function() {
  if (window.__showcaseCursorInstalled) return;
  window.__showcaseCursorInstalled = true;

  const style = document.createElement('style');
  style.id = 'showcase-cursor-styles';
  style.textContent = \`
    #showcase-cursor {
      position: fixed;
      top: 0;
      left: 0;
      width: 22px;
      height: 22px;
      pointer-events: none;
      z-index: 2147483647;
      transition: opacity 0.2s ease;
      transform: translate3d(-100px, -100px, 0);
      will-change: transform;
    }
    #showcase-cursor svg {
      width: 100%;
      height: 100%;
      filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.35));
    }
    .showcase-click-ripple {
      position: fixed;
      width: 32px;
      height: 32px;
      margin-left: -16px;
      margin-top: -16px;
      border-radius: 50%;
      border: 3px solid rgba(37, 99, 235, 0.85);
      background: rgba(59, 130, 246, 0.25);
      pointer-events: none;
      z-index: 2147483646;
      animation: showcase-ripple 0.45s ease-out forwards;
    }
    @keyframes showcase-ripple {
      0% {
        transform: scale(0.3);
        opacity: 1;
      }
      100% {
        transform: scale(1.6);
        opacity: 0;
      }
    }
  \`;
  document.head.appendChild(style);

  const cursor = document.createElement('div');
  cursor.id = 'showcase-cursor';
  cursor.innerHTML = \`
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 3L11 20L14 13L21 10L4 3Z" fill="#2563EB" stroke="#FFFFFF" stroke-width="2" stroke-linejoin="round"/>
    </svg>
  \`;
  document.body.appendChild(cursor);

  window.__showcaseState = {
    x: 100,
    y: 100,
  };

  window.__showcaseSetPosition = function(x, y) {
    window.__showcaseState.x = x;
    window.__showcaseState.y = y;
    cursor.style.transform = 'translate3d(' + x + 'px, ' + y + 'px, 0)';
  };

  window.__showcaseClickEffect = function(x, y) {
    const ripple = document.createElement('div');
    ripple.className = 'showcase-click-ripple';
    ripple.style.left = x + 'px';
    ripple.style.top = y + 'px';
    document.body.appendChild(ripple);
    setTimeout(() => ripple.remove(), 500);
  };
})();
`;

async function injectCursor(page) {
  await page.addInitScript(CURSOR_INIT_SCRIPT);
  // Also run immediately if page already loaded
  await page.evaluate(CURSOR_INIT_SCRIPT).catch(() => {});
}

function cubicEaseInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

async function smoothMoveTo(page, targetX, targetY, durationMs = 500) {
  const current = await page.evaluate(() => {
    return window.__showcaseState || { x: 100, y: 100 };
  });

  const startX = current.x;
  const startY = current.y;
  const steps = Math.max(10, Math.floor(durationMs / 16));

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const eased = cubicEaseInOut(t);
    const curX = Math.round(startX + (targetX - startX) * eased);
    const curY = Math.round(startY + (targetY - startY) * eased);
    await page.evaluate(
      ({ x, y }) => {
        if (window.__showcaseSetPosition) window.__showcaseSetPosition(x, y);
      },
      { x: curX, y: curY },
    );
    await page.waitForTimeout(durationMs / steps);
  }
}

async function smoothMove(page, locator, durationMs = 450) {
  const box = await locator.boundingBox();
  if (!box) return;
  const targetX = Math.round(box.x + box.width / 2);
  const targetY = Math.round(box.y + box.height / 2);
  await smoothMoveTo(page, targetX, targetY, durationMs);
}

async function smoothClick(page, locator, options = {}) {
  await smoothMove(page, locator, options.moveDuration || 450);
  const box = await locator.boundingBox();
  if (box) {
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    await page.evaluate(
      ({ x, y }) => {
        if (window.__showcaseClickEffect) window.__showcaseClickEffect(x, y);
      },
      { x, y },
    );
  }
  await page.waitForTimeout(options.preClickWait || 80);
  await locator.click();
  await page.waitForTimeout(options.postClickWait || 250);
}

module.exports = {
  CURSOR_INIT_SCRIPT,
  injectCursor,
  smoothMoveTo,
  smoothMove,
  smoothClick,
};
