export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the selection-based path for restricted contexts.
  }

  const textarea = window.document.createElement('textarea')
  textarea.value = text
  textarea.readOnly = true
  textarea.style.position = 'fixed'
  textarea.style.inset = '-9999px auto auto -9999px'
  window.document.body.append(textarea)
  textarea.select()
  try {
    return window.document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}
