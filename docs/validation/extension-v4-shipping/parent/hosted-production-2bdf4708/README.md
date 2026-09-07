# Hosted production review — 2bdf4708

GitHub Actions run `34158014590`, production job `101853766510`, completed successfully. The review records successful image build and load, both Stage 2 checks, archival-base verification, all eight production proofs, and artifact upload.

The workflow checkout was synthetic PR merge `00e2b3ea26274cbd50c2b9ecea583881b39f257b`. Its tree `d2cb79e4a2f13651778886beb62594856f3aadc9` equals published PR head `2bdf4708594db3e27e25269e7c4fbb7cf0dc87f7`; therefore the recorded runtime image identity applies to the published head tree. `production-checkout-parent-verification.json` records the parent review.

`inspection.json` contains safe proof exits, launcher exit fields, the embedding log guard result, and image identity. `private-raw-inventory.json` maps every retained private raw CI log and artifact file to its original private path, byte count, and SHA-256. Raw logs, artifacts, authentication data, and browser archives are not published here. `inputs/ci.yml.txt` is the inert workflow source from the reviewed commit.

The overall workflow was red only because separate real-auth E2E and Gate integrity jobs failed. This receipt does not replace their investigation.
