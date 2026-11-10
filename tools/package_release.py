"""Create the user download from a checked-out, versioned release."""
from pathlib import Path
import re
import sys
import zipfile

root = Path(__file__).resolve().parent.parent
if len(sys.argv) != 3:
    raise SystemExit("Usage: python3 tools/package_release.py VERSION OUTPUT.zip")
version, output = sys.argv[1:]
if not re.fullmatch(r"\d+\.\d+\.\d+", version):
    raise SystemExit("Version must be MAJOR.MINOR.PATCH.")
source = (root / "DMsManager/version.ts").read_text(encoding="utf-8")
if f'export const VERSION = "{version}";' not in source:
    raise SystemExit("Tag version doesn't match DMsManager/version.ts. Update the version before tagging.")
notes = (root / "RELEASE_NOTES.md").read_text(encoding="utf-8")
if not notes.startswith(f"# MessagesManager {version}\n"):
    raise SystemExit("Update RELEASE_NOTES.md for this version before tagging.")
output_path = Path(output).resolve()
output_path.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as archive:
    for entry in sorted((root / "DMsManager").rglob("*")):
        if entry.is_symlink():
            raise SystemExit("Release source must not contain symlinks.")
        if entry.is_file():
            archive.write(entry, entry.relative_to(root))
    for filename in ("README.md", "LICENSE", "RELEASE_NOTES.md", "Install-DMsManager.cmd", "Install-DMsManager.ps1"):
        archive.write(root / filename, filename)
with zipfile.ZipFile(output_path) as archive:
    if archive.testzip() is not None:
        raise SystemExit("Archive integrity check failed.")
print(output_path)

