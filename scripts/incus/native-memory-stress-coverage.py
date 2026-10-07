#!/usr/bin/env python3
"""Measure the maintained C through real GCC instrumentation and fault tests."""

import argparse, gzip, importlib.util, json, pathlib, shutil, subprocess, tempfile, unittest

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "native_tests", HERE / "native-memory-stress.test.py"
)
tests = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tests)
parser = argparse.ArgumentParser()
parser.add_argument("--output", type=pathlib.Path, required=True)
args = parser.parse_args()
result = unittest.TextTestRunner().run(
    unittest.defaultTestLoader.loadTestsFromModule(tests)
)
if not result.wasSuccessful():
    raise SystemExit(1)
gcov = shutil.which("gcov")
if gcov is None:
    include = pathlib.Path(
        subprocess.check_output(["gcc", "-print-file-name=include"], text=True).strip()
    )
    gcov = str(include.parents[4] / "bin/gcov")
with tempfile.TemporaryDirectory(prefix="ezh-native-coverage-") as directory:
    executable = tests.compile_boundary(directory, coverage=True)
    subprocess.run([str(executable)], check=True, stdout=subprocess.DEVNULL, timeout=5)
    notes = list(pathlib.Path(directory).glob("*.gcno"))
    if len(notes) != 1:
        raise SystemExit("Expected one instrumented native compilation")
    subprocess.run(
        [gcov, "--json-format", str(notes[0])],
        cwd=directory,
        check=True,
        stdout=subprocess.DEVNULL,
    )
    files = []
    for path in pathlib.Path(directory).glob("*.gcov.json.gz"):
        files.extend(json.loads(gzip.decompress(path.read_bytes()))["files"])
    measured = [
        row for row in files if pathlib.Path(row["file"]).resolve() == tests.SOURCE
    ]
    if len(measured) != 1:
        raise SystemExit("Missing exact native source coverage")
    lines = measured[0]["lines"]
    if not lines or any(row["count"] == 0 for row in lines):
        raise SystemExit(
            "Native executable lines uncovered: "
            + str([row["line_number"] for row in lines if row["count"] == 0])
        )
    data = (
        "TN:native-memory-stress\nSF:"
        + str(tests.SOURCE.relative_to(tests.ROOT))
        + "\n"
    )
    data += "".join(
        "DA:" + str(row["line_number"]) + "," + str(row["count"]) + "\n"
        for row in lines
    )
    data += "LF:" + str(len(lines)) + "\nLH:" + str(len(lines)) + "\nend_of_record\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(data)
    print(
        json.dumps(
            {
                "source": str(tests.SOURCE.relative_to(tests.ROOT)),
                "measuredLines": len(lines),
                "coveredLines": len(lines),
                "producer": "gcc-gcov",
            }
        )
    )
