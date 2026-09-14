#!/usr/bin/env python3
"""SécuriSite — régénère les icônes PWA (frontend/manifest.json) depuis le
logo source. À relancer uniquement si assets/iron-global-securite-logo.png
change ; les fichiers générés sont commités (pas de build PWA au démarrage).

Nécessite Pillow (pip install pillow) — dépendance de maintenance
ponctuelle, jamais du runtime applicatif (Node uniquement).

Usage : python3 scripts/generate-pwa-icons.py
"""
from pathlib import Path
from PIL import Image

ASSETS = Path(__file__).resolve().parent.parent / 'frontend' / 'assets'
SOURCE = ASSETS / 'iron-global-securite-logo.png'

# Zone de sécurité W3C pour une icône "maskable" : le contenu doit tenir
# dans les 80% centraux du canevas — le masque adaptatif (cercle, squircle,
# carré arrondi...) d'un lanceur Android peut rogner toute la marge
# extérieure. Le logo source touche presque les bords de son propre
# canevas : appliqué tel quel en maskable, l'anneau doré serait coupé.
SAFE_ZONE_RATIO = 0.8
MASKABLE_BACKGROUND = (0x07, 0x0b, 0x14, 255)  # background_color/theme_color du manifest


def main():
    src = Image.open(SOURCE).convert('RGBA')

    for size in (192, 512):
        out = src.resize((size, size), Image.LANCZOS)
        dest = ASSETS / f'icon-{size}.png'
        out.save(dest)
        print(f'[icons] {dest.name} ({size}x{size}, purpose=any)')

    canvas_size = 512
    canvas = Image.new('RGBA', (canvas_size, canvas_size), MASKABLE_BACKGROUND)
    logo_size = int(canvas_size * SAFE_ZONE_RATIO)
    logo = src.resize((logo_size, logo_size), Image.LANCZOS)
    offset = ((canvas_size - logo_size) // 2, (canvas_size - logo_size) // 2)
    canvas.alpha_composite(logo, offset)
    dest = ASSETS / 'icon-maskable-512.png'
    canvas.convert('RGB').save(dest)
    print(f'[icons] {dest.name} ({canvas_size}x{canvas_size}, purpose=maskable)')


if __name__ == '__main__':
    main()
