# resolve_hunks.py: shared helper. resolve(path, [fn per hunk]) replaces each <<<<<<< / ======= / >>>>>>> hunk with fn(ours, theirs).
import re, sys
def resolve(path, fns):
    s = open(path).read()
    pat = re.compile(r'^<<<<<<< [^\n]*\n(.*?)^=======\n(.*?)^>>>>>>> [^\n]*\n', re.S | re.M)
    hunks = pat.findall(s)
    assert len(hunks) == len(fns), (path, len(hunks), len(fns))
    it = iter(fns)
    s = pat.sub(lambda m: next(it)(m.group(1), m.group(2)), s)
    assert '<<<<<<<' not in s and '>>>>>>>' not in s, path
    open(path, 'w').write(s)
def need(text, *parts):
    for p in parts: assert p in text, (p[:80],)
    return text
