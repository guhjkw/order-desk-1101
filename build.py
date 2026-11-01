"""Builds index.html from index.src.html: embeds data/sample.json (so the page also works opened off disk)
and the summary line of the last node test run (tests/test-output.txt), so the page never claims more than ran."""
import json
import pathlib
import re

root = pathlib.Path(__file__).resolve().parent
data = json.loads((root / "data" / "sample.json").read_text(encoding="utf-8"))
blob = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")

lines = [l for l in (root / "tests" / "test-output.txt").read_text(encoding="utf-8").splitlines() if l.strip()]
summary = lines[-1].strip()
m = re.fullmatch(r"(\d+) passed, (\d+) failed", summary)
assert m and m.group(2) == "0", "node tests are not green: " + summary
summary = m.group(1) + " node checks passed, 0 failed"

src = (root / "index.src.html").read_text(encoding="utf-8")
assert src.count("__FALLBACK__") == 1 and src.count("__TESTS__") == 1
(root / "index.html").write_text(src.replace("__FALLBACK__", blob).replace("__TESTS__", summary), encoding="utf-8")
print("index.html %d bytes; %s" % ((root / "index.html").stat().st_size, summary))
