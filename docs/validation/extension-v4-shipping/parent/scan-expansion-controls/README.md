# Archive expansion controls

This evidence is copied only from the recorded parent receipt:
`.cache/terra-shipping/parent/archive-expansion-parent-20260907T082600Z`.
It does not use a current helper or a new execution.

The recorded probe (`probe.py.txt`, SHA-256 `e62ec0f10bb4911160bf277950b119ac940c71c99f68ff3a576e5af1ebcc1ef7`) exercised the recorded
expander (`helper.py.txt`, SHA-256 `c8a425a1bc2c3087d695fd06d501bd56aa95932814d062934ff38fda10a9be57`). The successful case placed a ZIP
with two same-name members and a nested `tar.gz` containing a nested gzip. It exited
0, retained six distinct extracted records, kept duplicate members at distinct paths,
and verified every extracted payload hash. The three hostile-input controls each exited
1: invalid gzip, invalid ZIP, and a tar member with `../outside.txt`.

This proves the recorded archive-expansion logic preserves archive members and rejects
these corrupt or traversal inputs. It does **not** prove that the pending final Gitleaks
scan ran, scanned every final staged file, or produced a clean secret-scan result.

All Python artifacts use `.txt` names so they are inert evidence. No credentials,
archive payloads, or extracted temporary directories are included.
