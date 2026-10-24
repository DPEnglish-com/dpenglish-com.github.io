#!/usr/bin/env python3
"""从本机的 Source Han Serif SC Medium 生成母站 display 子集，输出 base64 内联片段。

用法：python3 tools/font-subset.py
把输出替换 index.html 里的 @font-face（字体名 HeadToToeDisplay）。
字体为 SIL OFL 1.1；不要把完整字体提交进仓库。
"""
import json, base64, subprocess, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
data = json.load(open(os.path.join(ROOT, 'data/products.json')))
chars = set('从头到脚六个产品各管一处六支片目录关于这个站产品宣传片在线试用看得见的一层层递进读完从头顶到脚')
for p in data['products']:
    chars.update(p['name'])
    chars.update(p['promise'])
chars.update(' ·—，。！？、：（）()/&0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ')
open('/tmp/display-chars.txt', 'w').write(''.join(sorted(chars)))
otf = os.path.expanduser('~/Library/Fonts/SourceHanSerifSC-Medium.otf')
if not os.path.exists(otf):
    raise SystemExit('找不到源字体：' + otf)
subprocess.run(['python3', '-m', 'fontTools.subset', otf,
                '--text-file=/tmp/display-chars.txt', '--flavor=woff2',
                '--output-file=/tmp/display.woff2', '--layout-features=*',
                '--no-hinting', '--desubroutinize'], check=True)
b64 = base64.b64encode(open('/tmp/display.woff2', 'rb').read()).decode()
print('@font-face{font-family:"HeadToToeDisplay";src:url(data:font/woff2;base64,' + b64 + ') format("woff2");font-weight:500;font-style:normal;font-display:swap;}')
