import os
import shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "texlive-packages")
DIR_26 = os.path.join(ROOT, "texlive", "pdftex", "26")
DIR_32 = os.path.join(ROOT, "texlive", "pdftex", "32")
DIR_3  = os.path.join(ROOT, "texlive", "pdftex", "3")

if not os.path.exists(SRC):
    print(f"Error: {SRC} does not exist.")
    exit(1)

count_26 = 0
count_32 = 0
count_3 = 0

print("Syncing files from texlive-packages/ to texlive/pdftex/ ...")

for root, dirs, files in os.walk(SRC):
    for f in files:
        ext = os.path.splitext(f)[1].lower()
        src_path = os.path.join(root, f)
        
        if ext == '.pfb':
            shutil.copy2(src_path, os.path.join(DIR_32, f))
            count_32 += 1
        elif ext == '.tfm':
            shutil.copy2(src_path, os.path.join(DIR_3, f))
            count_3 += 1
        else:
            shutil.copy2(src_path, os.path.join(DIR_26, f))
            count_26 += 1

print(f"  -> Synced {count_26} files to format 26 (macros/styles)")
print(f"  -> Synced {count_32} files to format 32 (PFB fonts)")
print(f"  -> Synced {count_3} files to format 3 (TFM fonts)")
print("\nDone! Remember to run compile-format.html in your browser if you changed core macro files.")
