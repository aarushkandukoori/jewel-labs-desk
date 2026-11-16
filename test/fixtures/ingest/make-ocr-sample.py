# Makes the OCR test images: a tiny fictional SAMPLE invoice snippet as ocr-sample.png and
# ocr-sample.jpg, plus ocr-sample.json with where each word was drawn (boxes from 0 to 1, origin at
# the top left). The OCR test reads all three.
# Run from anywhere:  python3 test/fixtures/ingest/make-ocr-sample.py
import json
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = os.path.join(HERE, '..', '..', '..', 'src', 'core', 'papers', 'fonts', 'Geist-Regular.ttf')

WIDTH, HEIGHT = 1000, 420
LINES = [
    'SAMPLE COMMERCIAL INVOICE',
    'Invoice No: EXP/26-27/28',
    'Date: 05/11/2026',
    'Consignee: SAMPLE Diamonds BVBA',
    'Total carats: 1.02',
]

font = ImageFont.truetype(FONT, 34)
image = Image.new('L', (WIDTH, HEIGHT), 255)
draw = ImageDraw.Draw(image)

words = []
y = 40
for line in LINES:
    x = 60
    for word in line.split(' '):
        draw.text((x, y), word, font=font, fill=0)
        x0, y0, x1, y1 = draw.textbbox((x, y), word, font=font)
        box = [round(x0 / WIDTH, 4), round(y0 / HEIGHT, 4), round(x1 / WIDTH, 4), round(y1 / HEIGHT, 4)]
        words.append({'text': word, 'box': box})
        x += font.getlength(word + ' ')
    y += 70

image.save(os.path.join(HERE, 'ocr-sample.png'), optimize=True)
image.save(os.path.join(HERE, 'ocr-sample.jpg'), quality=80)

# One word per line keeps the file short and easy to read.
rows = ',\n'.join('  ' + json.dumps(word) for word in words)
with open(os.path.join(HERE, 'ocr-sample.json'), 'w') as f:
    f.write('{"width": %d, "height": %d, "words": [\n%s\n]}\n' % (WIDTH, HEIGHT, rows))
print('wrote ocr-sample.png, ocr-sample.jpg and ocr-sample.json')
