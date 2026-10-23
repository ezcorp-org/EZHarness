# The W4H-35 prep line (integrator-5, 2026-10-23), lock-free, run ONLY on team-lead's word after validator-8's ACCEPT of 3698c8e84
# (verdict-w4h-35.txt 1a1d092727d57a54, 2026-10-23T02:42:51Z): PREP_REF = the full head 3698c8e84; PREP_BASE = integ/w00 802d46288; the fork
# point 063b3d16e is derived by the installed reprep.sh (R1); the third argument is kept for the record only. PG_HOOK is derived from the mapped list (no --pg-hook).
cd /tmp && PREP_REF=3698c8e842f2223e600ddbf65fe8d5b3d938a586 PREP_BASE=802d46288ab9f15310a5d54bd038b14075789286 bash evidence/integrator-5/reprep.sh 35-w16-k8s-profiles-3698c8e84-on-802d46288 3698c8e842f2223e600ddbf65fe8d5b3d938a586 063b3d16efc4074ebcf78a7df8c20fedfb54ccf0 --importers
