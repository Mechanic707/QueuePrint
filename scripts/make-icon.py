from pathlib import Path
from PIL import Image, ImageDraw

target = Path(__file__).resolve().parents[1] / 'assets'
target.mkdir(parents=True, exist_ok=True)
image = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((8, 8, 504, 504), radius=112, fill='#4564e8')
draw.rounded_rectangle((108, 190, 404, 360), radius=36, outline='white', width=17)
draw.rounded_rectangle((160, 104, 352, 218), radius=10, outline='white', width=17)
draw.rectangle((164, 185, 348, 211), fill='#4564e8')
draw.rounded_rectangle((160, 292, 352, 408), radius=10, fill='#4564e8', outline='white', width=17)
draw.line((204, 334, 307, 334), fill='white', width=11)
draw.line((204, 367, 278, 367), fill='white', width=11)
draw.ellipse((350, 231, 367, 248), fill='white')
image.save(target / 'icon.png')
image.save(target / 'icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
