/* 极简 Markdown 渲染（AI 讲解用）：先转义防 XSS，再解析
   支持：# 标题、**粗体**、*斜体*、`代码`、- 列表、1. 有序列表、```代码块```、换行 */

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
}

export function mdToHtml(src) {
  const lines = escapeHtml(src || '').split(/\r?\n/)
  const out = []
  let list = null // 'ul' | 'ol' | null
  let inCode = false
  let codeBuf = []

  const closeList = () => {
    if (list) {
      out.push(list === 'ul' ? '</ul>' : '</ol>')
      list = null
    }
  }

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      if (inCode) {
        out.push('<pre><code>' + codeBuf.join('\n') + '</code></pre>')
        codeBuf = []
        inCode = false
      } else {
        closeList()
        inCode = true
      }
      continue
    }
    if (inCode) {
      codeBuf.push(line)
      continue
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      closeList()
      const lv = h[1].length
      out.push(`<h${lv + 2}>${inline(h[2])}</h${lv + 2}>`)
      continue
    }

    const ul = line.match(/^\s*[-*]\s+(.*)$/)
    if (ul) {
      if (list !== 'ul') {
        closeList()
        out.push('<ul>')
        list = 'ul'
      }
      out.push(`<li>${inline(ul[1])}</li>`)
      continue
    }

    const ol = line.match(/^\s*\d+[.、)]\s+(.*)$/)
    if (ol) {
      if (list !== 'ol') {
        closeList()
        out.push('<ol>')
        list = 'ol'
      }
      out.push(`<li>${inline(ol[1])}</li>`)
      continue
    }

    if (!line.trim()) {
      closeList()
      continue
    }
    closeList()
    out.push(`<p>${inline(line)}</p>`)
  }
  if (inCode) out.push('<pre><code>' + codeBuf.join('\n') + '</code></pre>')
  closeList()
  return out.join('')
}
