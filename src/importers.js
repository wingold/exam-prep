/* 题库导入解析：JSON / TXT-通用文本 / Excel
   归一化目标结构：
   { type: single|multi|judge|fill|essay, stem, options[], answer[], analysis, chapter, difficulty }
   Word(.docx) 由调用方先用 mammoth 提取纯文本，再走 parseText */

const TYPE_MAP = {
  单选: 'single', 单选题: 'single', 单项选择: 'single',
  多选: 'multi', 多选题: 'multi', 多项选择: 'multi',
  判断: 'judge', 判断题: 'judge',
  填空: 'fill', 填空题: 'fill',
  简答: 'essay', 简答题: 'essay', 问答: 'essay',
}

export function normType(t) {
  if (!t) return 'single'
  const s = String(t).trim()
  if (TYPE_MAP[s]) return TYPE_MAP[s]
  const low = s.toLowerCase()
  if (['single', 'multi', 'judge', 'fill', 'essay'].includes(low)) return low
  return 'single'
}

export function parseAnswer(str, type) {
  if (Array.isArray(str)) return str.map(String)
  const s = String(str ?? '').trim()
  if (!s) return []
  if (type === 'judge') {
    if (/^(对|正确|√|t|true|yes|y)/i.test(s)) return ['对']
    if (/^(错|错误|×|f|false|no|n)/i.test(s)) return ['错']
    return [s]
  }
  // "A" / "A,C" / "1,3" / "AC"
  return s
    .split(/[,，、\s]+/)
    .map((x) => x.replace(/[.．)）]/g, '').trim().toUpperCase())
    .filter(Boolean)
}

/* ========== JSON 导入（PRD 附录 A 格式，也兼容 questions/bank 扁平结构） ========== */

export function parseJson(text) {
  const data = JSON.parse(text)
  const bankName = data.bank?.name || data.name || ''
  const chapter = data.bank?.subject || data.chapter || ''
  let qs = data.questions || data
  if (!Array.isArray(qs)) throw new Error('JSON 中未找到 questions 数组')
  const questions = qs.map((q) => normalize({
    type: normType(q.type),
    stem: q.stem ?? q.title ?? q.question ?? '',
    options: q.options || q.choices || [],
    answer: parseAnswer(q.answer ?? q.rightAnswer, normType(q.type)),
    analysis: q.analysis ?? q.explain ?? q['解析'] ?? '',
    chapter: q.chapter || chapter || '',
    difficulty: q.difficulty ?? q.level ?? q['重点'] ?? '',
  })).filter((q) => q.stem)
  return { bankName, questions }
}

/* ========== Excel（SheetJS sheet_to_json，表头映射） ========== */

export function parseSheetRows(rows) {
  if (!rows.length) return { bankName: '', questions: [] }
  const header = rows[0].map((h) => String(h ?? '').trim())
  const find = (...keys) => {
    for (const k of keys) {
      const i = header.findIndex((h) => h.includes(k))
      if (i >= 0) return i
    }
    return -1
  }
  const iT = find('题型', '类型', 'type')
  const iS = find('题干', '题目', '问题', '题述')
  const iOpts = [0, 1, 2, 3, 4, 5].map((n) => find(`选项${'ABCDEF'[n]}`, `${'ABCDEF'[n]}.`, `${'ABCDEF'[n]}、`))
  const iA = find('答案', 'answer')
  const iE = find('解析', '分析', 'analysis')
  const iC = find('章节', '分类', 'chapter')
  const iD = find('难度', '重点', 'difficulty', 'level')
  if (iS < 0) throw new Error('Excel 未找到「题干」列（表头需含：题干/选项A/答案…）')

  const bankName = ''
  const questions = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    const stem = String(row[iS] ?? '').trim()
    if (!stem) continue
    const type = iT >= 0 ? normType(row[iT]) : 'single'
    const options = iOpts
      .filter((i) => i >= 0)
      .map((i) => String(row[i] ?? '').trim())
      .filter(Boolean)
    questions.push(normalize({
      type,
      stem,
      options: type === 'judge' && !options.length ? ['对', '错'] : options,
      answer: parseAnswer(iA >= 0 ? row[iA] : '', type),
      analysis: iE >= 0 ? String(row[iE] ?? '').trim() : '',
      chapter: iC >= 0 ? String(row[iC] ?? '').trim() : '',
      difficulty: iD >= 0 ? String(row[iD] ?? '').trim() : '',
    }))
  }
  return { bankName, questions }
}

/* ========== 通用文本（docx 提取文本 / TXT / 粘贴） ==========
   惯例格式：
   1. 题干……
   A. 选项
   B. 选项
   答案：B
   解析：……
   【章节】xxx   或行首"第x章"识别为章节 */

export function parseText(text) {
  const lines = text.split(/\r?\n/)
  const questions = []
  let cur = null
  let chapter = ''
  let sectionChapter = ''

  const flush = () => {
    if (cur && cur.stem) questions.push(normalize(cur))
    cur = null
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    // 章节行
    const chMatch = line.match(/^(?:【章节】|章节[::])\s*(.+)$/) || line.match(/^(第[0-9一二三四五六七八九十]+[章节])\s*(.+)$/)
    if (chMatch) {
      sectionChapter = chMatch[2] ? `${chMatch[1]} ${chMatch[2]}` : chMatch[1]
      continue
    }

    // 题号开头：1. / 1、 / 1） / 1．
    const qMatch = line.match(/^(\d{1,3})\s*[.、．)）]\s*(.*)$/)
    const isOption = /^[A-Fa-f]\s*[.、．)）]\s*/.test(line)

    if (qMatch && !isOption) {
      const body = qMatch[2]
      // 新题
      flush()
      // 同一行里可能带 "答案：X"
      const inlineAns = body.match(/答案[::]\s*([A-Fa-f对错√×]+)/)
      cur = {
        type: 'single',
        stem: body.replace(/答案[::].*$/, '').trim(),
        options: [],
        answer: inlineAns ? parseAnswer(inlineAns[1], 'single') : [],
        analysis: '',
        chapter: sectionChapter || chapter,
        difficulty: '',
      }
      continue
    }

    if (!cur) continue

    // 选项
    if (isOption) {
      const m = line.match(/^([A-Fa-f])\s*[.、．)）]\s*(.*)$/)
      cur.options.push(m[2].trim())
      continue
    }

    // 答案 / 解析 / 题型标记
    const ansM = line.match(/^(?:【答案】|答案)[::]\s*(.+)$/)
    if (ansM) {
      cur.answer = parseAnswer(ansM[1], cur.type)
      continue
    }
    const expM = line.match(/^(?:【解析】|解析)[::]\s*(.*)$/)
    if (expM) {
      cur.analysis = expM[1]
      continue
    }
    const typeM = line.match(/^(?:【题型】|题型)[::]\s*(.+)$/)
    if (typeM) {
      cur.type = normType(typeM[1])
      continue
    }
    const chapM = line.match(/^(?:【章节】|章节)[::]\s*(.+)$/)
    if (chapM) {
      cur.chapter = chapM[1]
      continue
    }
    const difM = line.match(/^(?:【重点】|【难度】|难度)[::]\s*(.*)$/)
    if (difM) {
      cur.difficulty = difM[1] || '重点'
      continue
    }
    if (line === '【重点】') {
      cur.difficulty = '重点'
      continue
    }

    // 续行
    cur.stem += (cur.options.length || cur.answer.length || cur.analysis ? '\n' : ' ') + line
  }
  flush()
  return { bankName: '', questions }
}

/* ========== 归一化 ========== */

export function normalizeQuestion(q) {
  return normalize(q)
}

function normalize(q) {
  const type = normType(q.type)
  let options = (q.options || []).map(String)
  let answer = (q.answer || []).map(String)

  if (type === 'judge') {
    if (!options.length) options = ['对', '错']
    // 判断题答案统一为 对/错
    answer = answer.map((a) => {
      if (/^(对|正确|√|t|true)$/i.test(a)) return '对'
      if (/^(错|错误|×|f|false)$/i.test(a)) return '错'
      return a
    })
  }
  // 单选答案若写成小写字母 → 大写
  if (type === 'single' || type === 'multi') {
    answer = answer.map((a) => a.toUpperCase())
    // 选项存在时把 "A" 形式保留为字母（判定时按索引比对）
  }
  if (type === 'fill' || type === 'essay') {
    answer = answer.length ? answer : String(q.answerRaw ?? '').split(/[/；;]/).filter(Boolean)
  }

  return {
    type,
    stem: String(q.stem || '').trim(),
    options,
    answer,
    analysis: String(q.analysis || '').trim(),
    chapter: String(q.chapter || '').trim(),
    difficulty: normDifficulty(q.difficulty),
  }
}

/* 重点标记归一化：重点/是/1/high → '重点'，其余为空串 */
export function normDifficulty(d) {
  const s = String(d ?? '').trim()
  if (!s) return ''
  if (/^(重点|高|是|y|yes|true|1|high|hard)$/i.test(s)) return '重点'
  return s
}

export function isKeyQuestion(q) {
  return (q.difficulty || '') === '重点'
}

/* ========== 答题判定 ========== */

export function isCorrect(q, chosen) {
  if (!chosen || !chosen.length) return false
  if (q.type === 'fill' || q.type === 'essay') {
    const a = (q.answer[0] || '').trim().toLowerCase()
    const c = (chosen[0] || '').trim().toLowerCase()
    if (!a || !c) return false
    return a === c || a.includes(c) || c.includes(a)
  }
  if (q.type === 'judge') {
    return (chosen[0] || '') === (q.answer[0] || '')
  }
  // 选项类：按字母索引比对
  const setA = new Set(q.answer.map((x) => x.toUpperCase()))
  const setC = new Set(chosen.map((x) => String(x).toUpperCase()))
  if (setA.size !== setC.size) return false
  for (const x of setA) if (!setC.has(x)) return false
  return true
}
