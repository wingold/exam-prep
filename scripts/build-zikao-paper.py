#!/usr/bin/env python3
"""自考真题（全国统考卷）→ 题库 JSON

适用版面：题面在前、「试题答案及评分参考」在后，两段用这个标题分隔。
题面按大题分节（一、单项选择题……六、案例分析题），选项可能一行一个，
也可能一行两个（A．xxx  B．xxx），甚至用全角逗号当分隔（A，xxx），
所以不能按行切，要按选项标记切。

用法：
    python scripts/build-zikao-paper.py <题面txt> -o <输出json> \
        --name "行政法学 00261 · 2021年4月真题" --subject 00261

只输出 app 的题库格式。材料题（案例分析）默认不收录：主观性太强，
AI 出不好也判不了，组卷时也用不到。
"""
import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

# 大题标题 → 题型
SECTION_TYPES = {
    '单项选择题': 'single',
    '多项选择题': 'multi',
    '名词解释题': 'term',
    '简答题': 'short',
    '论述题': 'essay',
    '案例分析题': 'material',
    '材料题': 'material',
}

KEEP = {'single', 'multi', 'term', 'short', 'essay'}

# 题号与选项的间隔符：半角句点、全角句号、顿号、全角逗号都要认
SEP = r'[．.、，,]'
NUM_RE = re.compile(r'^(\d{1,2})\s*' + SEP + r'\s*(.*)$')
SEC_RE = re.compile(r'^([一二三四五六七八])\s*[、．.]\s*(.+)$')
OPT_RE = re.compile(r'([A-E])\s*' + SEP + r'\s*')
# 答案区横排时题号前面是空格，用它避免把「20 日内」当成题号
ANS_NO_RE = re.compile(r'(?:^|(?<=\s))(\d{1,2})\s*' + SEP + r'\s*')


def clean(s):
    s = s.replace('\u3000', ' ').replace('\xa0', ' ')
    s = re.sub(r'[ \t]+', ' ', s)
    return s.strip()


def strip_section_header(line):
    """大题标题行 → 去掉「一、单项选择题（……）」后的剩余部分"""
    m = re.match(r'^[一二三四五六七八]\s*[、．.]\s*[^（(）)]*', line)
    if not m:
        return ''
    rest = line[m.end():].strip()
    if rest.startswith(('（', '(')):
        close = max(rest.rfind('）'), rest.rfind(')'))
        rest = rest[close + 1:].strip() if close > 0 else ''
    return rest


def split_options(block):
    """把「A．xxx B．xxx」这种挤在一行的选项拆开。

    按选项标记的位置切，标记本身不参与内容；只认前面是行首或空白的标记，
    避免选项正文里出现单个字母时被误判成新选项。
    """
    hits = [m for m in OPT_RE.finditer(block) if m.start() == 0 or block[m.start() - 1] in ' \n\t']
    out = []
    for i, m in enumerate(hits):
        end = hits[i + 1].start() if i + 1 < len(hits) else len(block)
        text = clean(block[m.end():end])
        if text:
            out.append((m.group(1), text))
    return out


def parse_questions(text):
    """题面 → [{no, type, stem, options}]"""
    items = []
    cur = None
    section = None

    def flush():
        nonlocal cur
        if cur:
            items.append(cur)
            cur = None

    for raw in text.split('\n'):
        line = clean(raw)
        if not line:
            continue

        msec = SEC_RE.match(line)
        if msec:
            title = msec.group(2)
            key = next((k for k in SECTION_TYPES if title.startswith(k)), None)
            # 换大题先把上一题收好，否则每大题最后一题会被吃掉
            flush()
            section = SECTION_TYPES.get(key)
            line = strip_section_header(line)
            if not line:
                continue

        if section is None:
            continue

        m = NUM_RE.match(line)
        if m:
            flush()
            cur = {'no': int(m.group(1)), 'type': section, 'lines': [m.group(2)]}
            continue
        if cur is None:
            continue
        cur['lines'].append(line)
    flush()

    for it in items:
        block = '\n'.join(it['lines'])
        if it['type'] in ('single', 'multi'):
            first = OPT_RE.search(block)
            if first:
                it['stem'] = clean(block[:first.start()])
                it['options'] = [t for _, t in split_options(block[first.start():])]
            else:
                it['stem'] = clean(block)
                it['options'] = []
        else:
            it['stem'] = clean(re.sub(r'\s*\n\s*', '', block))
            it['options'] = []
        it.pop('lines', None)
    return items


def parse_answers(text):
    """答案与评分参考 → {题号: 答案}

    客观题答案横排（「1．B  2．C  3．D」一行五题），所以要在一行里找出所有题号；
    大题标题行不属于任何题，遇到就跳过，不然会被拼到上一题的答案末尾。
    """
    out = {}
    cur_no = None
    for raw in text.split('\n'):
        line = clean(raw)
        if not line:
            continue
        if SEC_RE.match(line):
            cur_no = None
            continue
        marks = list(ANS_NO_RE.finditer(line))
        if not marks:
            if cur_no is not None:
                out[cur_no] = (out[cur_no] + '\n' + line).strip()
            continue
        for i, m in enumerate(marks):
            no = int(m.group(1))
            end = marks[i + 1].start() if i + 1 < len(marks) else len(line)
            body = line[m.end():end].strip()
            if not body:
                continue
            out[no] = (out[no] + '\n' + body).strip() if no in out else body
            cur_no = no
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src', help='题面 + 答案 的纯文本')
    ap.add_argument('-o', '--out', required=True)
    ap.add_argument('--name', required=True)
    ap.add_argument('--subject', default='')
    ap.add_argument('--keep-material', action='store_true', help='保留材料题（默认不收录）')
    args = ap.parse_args()

    raw = Path(args.src).read_text(encoding='utf-8')
    idx = raw.find('答案及评分参考')
    if idx < 0:
        sys.exit('找不到「答案及评分参考」，无法定位答案区')
    qpart, apart = raw[:idx], raw[idx:]
    apart = apart.split('\n', 1)[1] if '\n' in apart else apart

    items = parse_questions(qpart)
    answers = parse_answers(apart)

    questions, missing = [], []
    for it in items:
        t = it['type']
        if t not in KEEP and not args.keep_material:
            continue
        ans = answers.get(it['no'], '')
        if not ans:
            missing.append((it['no'], '无答案'))
            continue
        if t in ('single', 'multi'):
            letters = re.findall(r'[A-E]', ans.split('\n')[0])
            if len(it['options']) < 4:
                missing.append((it['no'], '选项只切出 %d 个' % len(it['options'])))
                continue
            if not letters:
                missing.append((it['no'], '答案无字母'))
                continue
            q = {'type': t, 'chapter': '真题卷', 'stem': it['stem'],
                 'options': it['options'], 'answer': letters, 'analysis': ''}
        else:
            q = {'type': t, 'chapter': '真题卷', 'stem': it['stem'],
                 'options': [], 'answer': [ans], 'analysis': ''}
        questions.append((it['no'], q))

    questions.sort(key=lambda x: x[0])
    bank = {
        'version': 1,
        'bank': {'name': args.name, 'subject': args.subject or ''},
        'questions': [q for _, q in questions],
    }
    Path(args.out).write_text(json.dumps(bank, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    print('写出', args.out)
    print('题量', len(bank['questions']), dict(Counter(q['type'] for q in bank['questions'])))
    if missing:
        print('跳过：', missing)


if __name__ == '__main__':
    main()
