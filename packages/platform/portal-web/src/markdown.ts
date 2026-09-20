import DOMPurify from 'dompurify'
import { marked } from 'marked'

marked.setOptions({ gfm: true, breaks: true })

/** Markdown → sanitized HTML. */
export function renderMarkdown(text: string): string {
  // ponytail: full re-parse per streaming chunk is O(n²) per message; switch
  // to incremental block parsing if answers ever reach ~100 KB.
  return DOMPurify.sanitize(marked.parse(text, { async: false }))
}
