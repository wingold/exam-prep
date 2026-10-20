#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把抓取到的自考真题页面组装成应用可导入的题库 JSON。

设计原则：
- 题干、选项逐字取自页面文本，只做空白清理，不做任何改写或润色；
- 答案取自官方《试题答案及评分参考》，与题目按题号一一对应；
- 材料题（案例分析题）不录入：主观性太强，无法与 AI 出题口径统一。

用法：
  python scripts/build-zikao-bank.py .exam-tmp/a0808q.txt
"""
import json
import pathlib
import re
import sys

# 2020 年 8 月高等教育自学考试全国统一命题考试《行政法学》(00261)
# 试题答案及评分参考 —— 客观题答案表
SINGLE_KEY = {
    1: 'C', 2: 'B', 3: 'A', 4: 'D', 5: 'B', 6: 'C', 7: 'C', 8: 'D', 9: 'A', 10: 'C',
    11: 'A', 12: 'B', 13: 'A', 14: 'C', 15: 'B', 16: 'B', 17: 'C', 18: 'D', 19: 'B', 20: 'B',
    21: 'C', 22: 'A', 23: 'B', 24: 'A', 25: 'C', 26: 'A', 27: 'C', 28: 'A', 29: 'C', 30: 'D',
}
MULTI_KEY = {31: 'ABCDE', 32: 'ABC', 33: 'ADE', 34: 'ABCD', 35: 'ABCDE'}

# 名词解释 36-40 参考答案（评分参考原文）
TERM_KEY = {
    36: '指享有国家行政权，能以自己的名义行使行政权，并能独立地承担因此而产生的相应法律责任的组织。',
    37: '指行政主体在内部行政组织管理过程中所作的只对行政组织内部产生法律效力的行政行为。',
    38: '指国务院制定行政法规和国务院各部门制定部门规章的活动。',
    39: '指行政主体依照法定条件和程序，对为国家和社会作出重大贡献的单位或个人，给予物质或精神鼓励的具体行政行为。',
    40: '指行政主体依法要求行政相对人“为”或“不为”一定行为的意思表示。',
}

SHORT_KEY = {
    41: '（1）选择合同相对人的权利。（1分）\n（2）对合同履行的监督权和指挥权。（1分）\n（3）单方面变更或解除合同的权利。（1分）\n（4）对不履行或不适当履行合同义务的相对人的制裁权。（2分）',
    42: '（1）监督和控制行政权的作用。（2分）\n（2）保护相对人合法权益的作用。（2分）\n（3）提高行政效率的作用。（1分）',
    43: '（1）存在违反行政法律义务的行为。（2分）\n（2）存在承担责任的法律根据。（2分）\n（3）主观过错的要件性问题。（1分）',
}

ESSAY_KEY = {
    44: '（1）公共服务性。（1分）\n（2）从属法律性。（1分）\n（3）裁量性。（1分）\n（4）单方意志性。（1分）\n（5）效力先定性。（1分）\n（6）强制性。（1分）\n（7）结合上述要点展开论述。（4分）',
}

TYPE_MAP = {
    '单选题': 'single',
    '多选题': 'multi',
    '名词解释题': 'term',
    '简答题': 'short',
    '论述题': 'essay',
    '案例分析题': 'material',
}

JUNK = {'查看答案', '-->', '预览与源文档一致', ''}


def clean(line):
    s = line.replace('\u3000', ' ')
    # 页面模板在选项前留了 HTML 注释残片，形如 "-->A."，先剥掉
    s = re.sub(r'^(?:\s*-->)+\s*', '', s)
    s = re.sub(r'[ \t]+', ' ', s).strip()
    return s


def parse(path):
    """按「N、[题型]题干 / A. 选项」的版面切题。

    页面里有两种标记写法（同一模板的两套排版）：
      "1、[单选题]题干……"      标记与题干同行
      "31、" 换行 "[多选题]"    标记与题型分行
    两种都要吃，否则多选题会整段丢失。
    """
    lines = [clean(l) for l in pathlib.Path(path).read_text(encoding='utf-8').split('\n')]
    items, cur, state = [], None, 'idle'
    pending = None

    for line in lines:
        if not line or line in JUNK or line == '-->':
            continue

        # 大题标题：选项区到此结束，后面可能是下一大题的题干
        if re.match(r'^[一二三四五六]、', line):
            if state in ('opts', 'stem'):
                state = 'stop'
            continue

        m = re.match(r'^(\d{1,2})、\s*(.*)$', line)
        if m:
            if cur:
                items.append(cur)
            cur = {'no': int(m.group(1)), 'type': None, 'stem_lines': [], 'options': []}
            rest = m.group(2).strip()
            mt = re.match(r'^\[(.+?)\]\s*(.*)$', rest)
            if mt:
                cur['type'] = mt.group(1)
                state = 'stem'
                if mt.group(2).strip():
                    cur['stem_lines'].append(mt.group(2).strip())
                    state = 'opts'
            else:
                state = 'type'
            continue

        if cur is None:
            continue

        if state == 'type':
            mt = re.match(r'^\[(.+?)\]\s*(.*)$', line)
            if mt:
                cur['type'] = mt.group(1)
                state = 'stem'
                if mt.group(2).strip():
                    cur['stem_lines'].append(mt.group(2).strip())
                    state = 'opts'
            continue

        if state == 'stop':
            continue

        if state == 'stem':
            if cur['type'] in ('单选题', '多选题') and re.match(r'^[A-E]\.$', line):
                pending = line[0]
                state = 'opt_text'
                continue
            cur['stem_lines'].append(line)
            state = 'opts'
            continue

        if state == 'opts':
            mo = re.match(r'^([A-E])[.．，,、]\s*(.*)$', line)
            if mo:
                if mo.group(2):
                    cur['options'].append(mo.group(2).strip())
                else:
                    pending = mo.group(1)
                    state = 'opt_text'
                continue
            continue

        if state == 'opt_text':
            cur['options'].append(line)
            state = 'opts'
            pending = None
            continue

    if cur:
        items.append(cur)
    return items


def build(items):
    out = []
    for it in items:
        t = TYPE_MAP.get(it['type'])
        if not t:
            continue
        if t == 'material':
            continue  # 材料题不录入
        stem = ' '.join(x for x in it['stem_lines'] if x).strip()
        stem = re.sub(r'\s+', ' ', stem)
        q = {'type': t, 'chapter': '真题卷', 'stem': stem}

        if t in ('single', 'multi'):
            q['options'] = it['options']
            key = SINGLE_KEY if t == 'single' else MULTI_KEY
            ans = key.get(it['no'])
            if not ans:
                print(f'  !! 第 {it["no"]} 题缺答案，跳过', file=sys.stderr)
                continue
            q['answer'] = list(ans)
            if len(q['options']) not in (4, 5) or len(q['answer']) > len(q['options']):
                print(f'  !! 第 {it["no"]} 题选项数 {len(q["options"])}，跳过', file=sys.stderr)
                continue
            q['analysis'] = ''
        else:
            q['options'] = []
            key = {'term': TERM_KEY, 'short': SHORT_KEY, 'essay': ESSAY_KEY}[t]
            ans = key.get(it['no'])
            if not ans:
                print(f'  !! 第 {it["no"]} 题（{t}）缺参考答案，跳过', file=sys.stderr)
                continue
            q['answer'] = [ans]
            q['analysis'] = ''
        out.append(q)
    return out


def main():
    src = sys.argv[1]
    items = parse(src)
    qs = build(items)
    bank = {
        'version': 1,
        'bank': {
            'name': '行政法学 00261 · 2020年8月真题',
            'subject': '行政法学',
            'note': '江苏省自考行政管理（本科）00261。题干取自公开真题页面，答案取自官方《试题答案及评分参考》；材料题（案例分析）未录入。',
        },
        'questions': qs,
    }
    dest = pathlib.Path('banks/00261-行政法学-2020年8月真题.json')
    dest.parent.mkdir(exist_ok=True)
    dest.write_text(json.dumps(bank, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    from collections import Counter
    c = Counter(q['type'] for q in qs)
    print(f'入库 {len(qs)} 题：{dict(c)}', file=sys.stderr)
    print(f'written {dest}', file=sys.stderr)


if __name__ == '__main__':
    main()
