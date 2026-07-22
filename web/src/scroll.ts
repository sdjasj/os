export function scrollWindowTo(top: number) {
  window.scrollTo({ left: 0, top, behavior: 'instant' })
}

export function scrollElementIntoView(element: Element) {
  element.scrollIntoView({ block: 'start', behavior: 'instant' })
}
