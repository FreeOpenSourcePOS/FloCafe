import * as React from "react"

const MOBILE_BREAKPOINT = 768

// Subscribes to the viewport media query as an external store, rather than mirroring it into
// state via useEffect — this is React's recommended pattern for browser APIs and avoids the
// setState-in-effect flash on mount while staying safe for the static-export (SSR) build.
function subscribe(onChange: () => void) {
  const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

function getSnapshot() {
  return window.innerWidth < MOBILE_BREAKPOINT
}

function getServerSnapshot() {
  return false
}

export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
