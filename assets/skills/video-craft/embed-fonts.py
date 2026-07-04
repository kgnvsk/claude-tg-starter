# Генератор fonts.css с вшитыми (base64) шрифтами — для надёжного видео-рендера.
# Скачай нужные woff2 рядом, пропиши их в FACES, запусти -> fonts.css.
# Подключение в index.html:  <link rel="stylesheet" href="fonts.css">
import base64, os, sys

SRC = sys.argv[1] if len(sys.argv) > 1 else "."   # папка с woff2
OUT = os.path.join(SRC, "fonts.css")

# (family, weight, файл, unicode-range|"")  — правь под свои шрифты
LAT = "U+0000-00FF,U+0131,U+0152-0153,U+2000-206F,U+2074,U+20AC,U+2122,U+2212,U+2215,U+FEFF,U+FFFD"
CYR = "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116"
FACES = [
    ("Fixel", 900, "FixelDisplay-Black.woff2",  ""),
    ("Fixel", 700, "FixelDisplay-Bold.woff2",   ""),
    ("FixelT", 500, "FixelText-Medium.woff2",   ""),
    ("FixelT", 600, "FixelText-SemiBold.woff2", ""),
    ("JBM", 500, "JBM-latin-500.woff2",     LAT),
    ("JBM", 500, "JBM-cyrillic-500.woff2",  CYR),
    ("JBM", 700, "JBM-latin-700.woff2",     LAT),
    ("JBM", 700, "JBM-cyrillic-700.woff2",  CYR),
]

def face(fam, wt, fn, urange):
    p = os.path.join(SRC, fn)
    if not os.path.exists(p):
        print("  ПРОПУСК (нет файла):", fn); return None
    b = base64.b64encode(open(p, "rb").read()).decode()
    ur = f"unicode-range:{urange};" if urange else ""
    return (f"@font-face{{font-family:'{fam}';font-style:normal;font-weight:{wt};"
            f"font-display:block;{ur}src:url(data:font/woff2;base64,{b}) format('woff2');}}")

css = [c for c in (face(*f) for f in FACES) if c]
open(OUT, "w").write("\n".join(css))
print("fonts.css:", round(os.path.getsize(OUT) / 1024), "KB,", len(css), "начертаний")
