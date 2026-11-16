"""Optional image/Unicode QA using Pillow; no print, properties, or cancel commands."""
import json
import math
import shutil
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
fixtures = root / "tests" / "fixtures"
fixtures.mkdir(parents=True, exist_ok=True)
host = root / "publish" / "QueuePrint.Host.exe"


def call(command, **fields):
    assert command in {"inspect", "render", "plan"}
    result = subprocess.run(
        [str(host)], input=json.dumps({"command": command, **fields}, ensure_ascii=False) + "\n",
        capture_output=True, text=True, encoding="utf-8", check=True,
    )
    response = json.loads(result.stdout.splitlines()[-1])
    assert response["ok"], response
    return response["data"]


image = Image.new("RGB", (240, 120), "white")
ImageDraw.Draw(image).rectangle((0, 0, 110, 110), fill="red")
exif = Image.Exif()
exif[274] = 6  # 90 degrees clockwise; horizontal/vertical density must swap too.
jpeg = fixtures / "EXIF旋转与非对称DPI.jpg"
image.save(jpeg, exif=exif, dpi=(120, 60))
result = call("inspect", paths=[str(jpeg)])["files"][0]
assert math.isclose(result["width"], 200, abs_tol=1), result
assert math.isclose(result["height"], 200, abs_tol=1), result
rendered = fixtures / "exif-render-check.png"
call("render", paths=[str(jpeg)], outputPath=str(rendered), renderDpi=96)
with Image.open(rendered) as check:
    # Top-left red rectangle moves into the top half after clockwise rotation.
    assert check.getpixel((100, 30))[0] > 180
    assert check.getpixel((100, 170))[1] > 180

tiff = fixtures / "多页扫描图.tiff"
frames = [Image.new("RGB", (240, 120), color) for color in ("red", "green", "blue")]
frames[0].save(tiff, save_all=True, append_images=frames[1:], dpi=(120, 120))
result = call("inspect", paths=[str(tiff)])["files"][0]
assert result["pages"] == 3, result
rendered = fixtures / "tiff-render-check.png"
call("render", paths=[str(tiff)], pageNumber=3, outputPath=str(rendered), renderDpi=96)
with Image.open(rendered) as check:
    assert check.getpixel((40, 40))[2] > 200

source_pdf = fixtures / "native-three-pages.pdf"
if source_pdf.exists():
    target = fixtures / "中文子目录" / "10-自建测试.pdf"
    target.parent.mkdir(exist_ok=True)
    shutil.copyfile(source_pdf, target)
    result = call("inspect", paths=[str(target)])["files"][0]
    assert result["pages"] == 3, result
    plan = call("plan", documents=[{"path": str(target), "pages": [3, 1]}])
    assert [page["page"] for page in plan["jobs"][0]["pages"]] == [3, 1]

print("PASS: JPEG EXIF rotation, asymmetric DPI, multi-page TIFF and Unicode PDF paths; no printing.")
