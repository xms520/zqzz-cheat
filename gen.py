#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 zqzz_js.c（把注入 JS 转成 C 字面量）并做逐字节自校验"""
import os, sys

BASE = "/var/minis/shared/zqzz/src"
js = open(os.path.join(BASE, "zqzz_inject.js"), "rb").read().decode("utf-8")

def c_escape(s):
    out = []
    for ch in s:
        if ch == "\\":
            out.append("\\\\")
        elif ch == '"':
            out.append('\\"')
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif ord(ch) < 0x20:
            out.append("\\%03o" % ord(ch))
        else:
            out.append(ch)
    return "".join(out)

# ⚠️ 关键：先分块，再逐块转义（反序会劈开 \\ 或 \"，导致字符串提前闭合）
def chunks(s, n=1600):
    return [s[i:i+n] for i in range(0, len(s), n)]

lines = []
lines.append('/* 自动生成：注入用 JS（勿手改，改 zqzz_inject.js 后重跑 gen.py） */\n')
lines.append('static const char *kZqzzJs =\n')
for c in chunks(js):
    lines.append('    "%s"\n' % c_escape(c))
lines.append(';\n')
lines.append("const char *zqzz_inject_js(void) { return kZqzzJs; }\n")

out = "".join(lines)
open(os.path.join(BASE, "zqzz_js.c"), "w").write(out)
print("zqzz_js.c generated: %d bytes, js=%d chars" % (len(out), len(js)))

# 自校验：把 C 字面量解回字符串，与原文逐字节比对
import re
body = out[out.index('static const char *kZqzzJs'):]
lits = re.findall(r'"((?:[^"\\]|\\.)*)"', body)
def unesc(s):
    r = []
    i = 0
    while i < len(s):
        if s[i] == "\\":
            c = s[i+1]
            if c == "n": r.append("\n"); i += 2
            elif c == "r": r.append("\r"); i += 2
            elif c == "t": r.append("\t"); i += 2
            elif c == "\\": r.append("\\"); i += 2
            elif c == '"': r.append('"'); i += 2
            elif c.isdigit():
                r.append(chr(int(s[i+1:i+4], 8))); i += 4
            else:
                r.append(c); i += 2
        else:
            r.append(s[i]); i += 1
    return "".join(r)

recovered = "".join(unesc(x) for x in lits)
if recovered == js:
    print("SELFCHECK CLEAN (byte-identical)")
else:
    print("SELFCHECK FAIL len %d vs %d" % (len(recovered), len(js)))
    for i in range(min(len(recovered), len(js))):
        if recovered[i] != js[i]:
            print("first diff at", i, repr(recovered[i-60:i+60]), "|||", repr(js[i-60:i+60]))
            break
    sys.exit(1)
