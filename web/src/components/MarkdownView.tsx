import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { X, ZoomIn } from 'lucide-react'
import { renderMarkdown } from '../markdown'
import { copyText } from '../clipboard'
import type { ContentDocument, HeadingItem } from '../types'
import { useBodyScrollLock } from '../useBodyScrollLock'

interface MarkdownViewProps {
  content: ContentDocument
  onHeadings: (headings: HeadingItem[]) => void
}

export const MarkdownView = memo(function MarkdownView({ content, onHeadings }: MarkdownViewProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const imageOpenerRef = useRef<HTMLElement | null>(null)
  const [zoomedImage, setZoomedImage] = useState<{ src: string; alt: string } | null>(null)
  useBodyScrollLock(Boolean(zoomedImage))
  const rendered = useMemo(() => renderMarkdown(content), [content])
  const html = useMemo(() => ({ __html: rendered.html }), [rendered.html])

  useEffect(() => {
    onHeadings(rendered.headings)
  }, [onHeadings, rendered.headings])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const cleanups: Array<() => void> = []

    root.querySelectorAll<HTMLPreElement>('pre').forEach((pre) => {
      if (pre.querySelector(':scope > .code-actions')) return
      const actions = window.document.createElement('div')
      actions.className = 'code-actions'

      const wrapButton = window.document.createElement('button')
      wrapButton.type = 'button'
      wrapButton.className = 'code-action'
      wrapButton.title = '切换自动换行'
      wrapButton.setAttribute('aria-label', '切换代码自动换行')
      wrapButton.innerHTML = '<span aria-hidden="true">↩</span>'
      wrapButton.setAttribute('aria-pressed', 'false')
      const toggleWrap = () => {
        const wrapped = pre.classList.toggle('code-wrap')
        wrapButton.setAttribute('aria-pressed', String(wrapped))
      }
      wrapButton.addEventListener('click', toggleWrap)

      const copyButton = window.document.createElement('button')
      copyButton.type = 'button'
      copyButton.className = 'code-action'
      copyButton.title = '复制代码'
      copyButton.setAttribute('aria-label', '复制代码')
      copyButton.setAttribute('aria-live', 'polite')
      copyButton.innerHTML = '<span aria-hidden="true">⧉</span>'
      const copyCode = async () => {
        const text = pre.querySelector('code')?.textContent ?? ''
        try {
          if (!await copyText(text)) throw new Error('Clipboard unavailable')
          copyButton.classList.add('copied')
          copyButton.setAttribute('aria-label', '代码已复制')
          copyButton.innerHTML = '<span aria-hidden="true">✓</span>'
        } catch {
          copyButton.setAttribute('aria-label', '复制失败，请手动选择代码')
          copyButton.innerHTML = '<span aria-hidden="true">!</span>'
        }
        window.setTimeout(() => {
          copyButton.classList.remove('copied')
          copyButton.setAttribute('aria-label', '复制代码')
          copyButton.innerHTML = '<span aria-hidden="true">⧉</span>'
        }, 1400)
      }
      copyButton.addEventListener('click', copyCode)
      actions.append(wrapButton, copyButton)
      pre.append(actions)
      cleanups.push(() => {
        wrapButton.removeEventListener('click', toggleWrap)
        copyButton.removeEventListener('click', copyCode)
        actions.remove()
      })
    })

    const openImage = (image: HTMLImageElement) => {
      imageOpenerRef.current = image
      setZoomedImage({ src: image.src, alt: image.alt })
    }
    const imageClick = (event: Event) => {
      const image = (event.target as HTMLElement).closest<HTMLImageElement>('img[data-lightbox="true"]')
      if (!image) return
      openImage(image)
    }
    const imageKeydown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      const image = (event.target as HTMLElement).closest<HTMLImageElement>('img[data-lightbox="true"]')
      if (!image) return
      event.preventDefault()
      openImage(image)
    }
    root.addEventListener('click', imageClick)
    root.addEventListener('keydown', imageKeydown)
    cleanups.push(() => root.removeEventListener('click', imageClick))
    cleanups.push(() => root.removeEventListener('keydown', imageKeydown))

    return () => cleanups.forEach((cleanup) => cleanup())
  }, [rendered.html])

  useEffect(() => {
    if (!zoomedImage) return
    closeButtonRef.current?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setZoomedImage(null)
      if (event.key === 'Tab') {
        event.preventDefault()
        closeButtonRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('keydown', handleKey)
      const opener = imageOpenerRef.current
      const currentImage = [...(rootRef.current?.querySelectorAll<HTMLImageElement>('img[data-lightbox="true"]') ?? [])]
        .find((image) => image.src === zoomedImage.src)
      ;(opener?.isConnected ? opener : currentImage)?.focus()
    }
  }, [zoomedImage])

  return (
    <>
      <div
        ref={rootRef}
        className="markdown-body"
        dangerouslySetInnerHTML={html}
      />
      {zoomedImage && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label={zoomedImage.alt || '图片预览'} onClick={() => setZoomedImage(null)}>
          <button ref={closeButtonRef} className="lightbox-close" type="button" onClick={() => setZoomedImage(null)} aria-label="关闭图片预览">
            <X size={22} />
          </button>
          <div className="lightbox-badge"><ZoomIn size={15} /> 点击背景或按 Escape 关闭</div>
          <img src={zoomedImage.src} alt={zoomedImage.alt} onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </>
  )
})
