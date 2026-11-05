#!/usr/bin/env python3
"""Package already-curated comic images from local chapter sources into a GitHub Pages catalog.
Usage: python scripts/build_catalog.py --source /mnt/data --root .
"""
import argparse, json, zipfile
from io import BytesIO
from pathlib import Path
from PIL import Image

TITLES = {
    1: ('Человек, которого я жду','Дождливый город, китайские шахматы и тихое семейное расставание.','ready'),
    2: ('Обратный отсчёт','Белые цифры на предплечье и подготовка к неизвестному событию.','ready'),
    3: ('Разрушенный мир','Прощальное письмо, остановка времени и незнакомое пробуждение.','preview'),
    4: ('Больше одного','Семиуровневый тюремный бастион и первое столкновение с механическим миром.','ready'),
    5: ('Трансцендентный статус','Ли Шутун в белом, доска сянци и большая серая кошка.','preview'),
}


def source_pages(src):
    result = {}
    result[1] = [(src/'Nomenklatura_Nochi_Chapter01_Atmosphere'/f'{n:02d}.png').read_bytes() for n in range(1,10)]
    chapter2 = ['номенклатура_ночи_дождливый_отсчёт.png','номенклатура_ночи_обратный_отсчёт.png','номенклатура_ночи_запасы_перед_бурей.png','ночь_перед_отсчётом.png']
    result[2] = [(src/name).read_bytes() for name in chapter2]
    with zipfile.ZipFile(src/'Nomenklatura_Nochi_Chapter03_Storyboard.zip') as z:
        result[3] = [z.read(f'{n:02d}.png') for n in range(1,5)]
    with zipfile.ZipFile(src/'Nomenklatura_Nochi_Chapter04_Complete.zip') as z:
        result[4] = [z.read(f'pages/{n:02d}.webp') for n in range(1,5)]
    result[5] = [(src/'Nomenklatura_Nochi_Chapter05_Full'/'assets'/f'{n:02d}.webp').read_bytes() for n in range(1,8)]
    return result


def build(src,root,width,quality):
    all_pages=source_pages(src)
    catalog={'version':1,'chapters':[]}
    for chapter, pages in sorted(all_pages.items()):
        title,desc,state=TITLES[chapter]
        info={'id':chapter,'title':title,'description':desc,'state':state,'pages':[]}
        chapter_dir = root/'chapters'/f'{chapter:02d}'
        chapter_dir.mkdir(parents=True,exist_ok=True)
        for idx, data in enumerate(pages,1):
            im=Image.open(BytesIO(data)).convert('RGB')
            new_width=min(im.width,width)
            new_height=round(im.height*new_width/im.width)
            if new_width!=im.width: im=im.resize((new_width,new_height),Image.Resampling.LANCZOS)
            name=f'{idx:02d}.webp'
            im.save(chapter_dir/name,format='WEBP',quality=quality,method=6)
            info['pages'].append({'src':f'chapters/{chapter:02d}/{name}','width':new_width,'height':new_height})
        catalog['chapters'].append(info)
        print(f'Глава {chapter}: {len(pages)} страниц, {sum(p.stat().st_size for p in chapter_dir.glob("*.webp"))/1048576:.2f} MiB')
    (root/'data').mkdir(exist_ok=True,parents=True)
    (root/'data'/'catalog.json').write_text(json.dumps(catalog,ensure_ascii=False,indent=2),encoding='utf-8')
    return catalog

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--source',default='/mnt/data');ap.add_argument('--root',default='.');ap.add_argument('--width',type=int,default=900);ap.add_argument('--quality',type=int,default=70)
    a=ap.parse_args();build(Path(a.source),Path(a.root),a.width,a.quality)