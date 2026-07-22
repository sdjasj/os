import { useEffect } from 'react'
import { scrollWindowTo } from './scroll'

let activeLocks = 0
let lockedScrollY = 0
let previousBodyStyles: {
  overflow: string
  paddingRight: string
  position: string
  top: string
  width: string
} | undefined

function lockBodyScroll() {
  activeLocks += 1
  if (activeLocks !== 1) return

  const { body, documentElement } = window.document
  lockedScrollY = window.scrollY
  previousBodyStyles = {
    overflow: body.style.overflow,
    paddingRight: body.style.paddingRight,
    position: body.style.position,
    top: body.style.top,
    width: body.style.width,
  }

  const scrollbarWidth = Math.max(0, window.innerWidth - documentElement.clientWidth)
  body.style.overflow = 'hidden'
  body.style.position = 'fixed'
  body.style.top = `-${lockedScrollY}px`
  body.style.width = '100%'
  if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`
  documentElement.dataset.overlayOpen = 'true'
}

function unlockBodyScroll() {
  activeLocks = Math.max(0, activeLocks - 1)
  if (activeLocks !== 0 || !previousBodyStyles) return

  const { body, documentElement } = window.document
  body.style.overflow = previousBodyStyles.overflow
  body.style.paddingRight = previousBodyStyles.paddingRight
  body.style.position = previousBodyStyles.position
  body.style.top = previousBodyStyles.top
  body.style.width = previousBodyStyles.width
  previousBodyStyles = undefined
  delete documentElement.dataset.overlayOpen
  scrollWindowTo(lockedScrollY)
}

export function useBodyScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return
    lockBodyScroll()
    return unlockBodyScroll
  }, [locked])
}
