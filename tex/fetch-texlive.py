import urllib.request
import tarfile
import os
import re
import sys
import ssl

# Python on Windows often can't find a CA store (CERTIFICATE_VERIFY_FAILED); prefer
# certifi's bundle when installed, else fall back to the system default.
try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl.create_default_context()

BASE_URL = "https://mirrors.rit.edu/CTAN/systems/texlive/tlnet/archive/"
ROOT = os.path.dirname(os.path.abspath(__file__))
DIR_26 = os.path.join(ROOT, "texlive", "pdftex", "26")
DIR_32 = os.path.join(ROOT, "texlive", "pdftex", "32")
DIR_3  = os.path.join(ROOT, "texlive", "pdftex", "3")
DIR_11 = os.path.join(ROOT, "texlive", "pdftex", "11")

TEX_EXTS = {'.tex', '.ltx', '.sty', '.def', '.cfg', '.fd', '.dfu', '.clo', '.cls', '.ldf', '.txt'}

def download(pkg):
    url = BASE_URL + pkg + ".tar.xz"
    dest = os.path.join(ROOT, pkg + ".tar.xz")
    if os.path.exists(dest):
        print(f"  (cached) {pkg}.tar.xz")
        return dest
    print(f"  Downloading {pkg}.tar.xz ...", end="", flush=True)
    # Write to a temp name so a failed download is never mistaken for a cached archive.
    tmp = dest + ".part"
    with urllib.request.urlopen(url, context=SSL_CTX) as resp, open(tmp, 'wb') as f:
        f.write(resp.read())
    os.replace(tmp, dest)
    size = os.path.getsize(dest)
    print(f" {size//1024}KB")
    return dest

def extract_tex(pkg, dest_dir):
    path = download(pkg)
    count = 0
    pkg_dir = os.path.join(ROOT, "texlive-packages", pkg)
    os.makedirs(pkg_dir, exist_ok=True)
    with tarfile.open(path, 'r:xz') as tar:
        for member in tar.getmembers():
            if not member.isfile():
                continue
            name = member.name
            ext = os.path.splitext(name)[1].lower()
            if ext not in TEX_EXTS:
                continue
            basename = os.path.basename(name)
            if not basename:
                continue
            data = tar.extractfile(member).read()
            with open(os.path.join(pkg_dir, basename), 'wb') as f:
                f.write(data)
            out = os.path.join(dest_dir, basename)
            with open(out, 'wb') as f:
                f.write(data)
            count += 1
    print(f"    -> {count} files extracted to texlive-packages/{pkg} and {os.path.relpath(dest_dir, ROOT)}")

def extract_pfb(pkg, dest_dir):
    path = download(pkg)
    count = 0
    pkg_dir = os.path.join(ROOT, "texlive-packages", pkg)
    os.makedirs(pkg_dir, exist_ok=True)
    with tarfile.open(path, 'r:xz') as tar:
        for member in tar.getmembers():
            if not member.isfile():
                continue
            name = member.name
            if not name.endswith('.pfb'):
                continue
            basename = os.path.basename(name)
            data = tar.extractfile(member).read()
            with open(os.path.join(pkg_dir, basename), 'wb') as f:
                f.write(data)
            out = os.path.join(dest_dir, basename)
            with open(out, 'wb') as f:
                f.write(data)
            count += 1
    print(f"    -> {count} PFB files extracted to texlive-packages/{pkg} and {os.path.relpath(dest_dir, ROOT)}")

def extract_tfm(pkg, dest_dir):
    path = download(pkg)
    count = 0
    pkg_dir = os.path.join(ROOT, "texlive-packages", pkg)
    os.makedirs(pkg_dir, exist_ok=True)
    with tarfile.open(path, 'r:xz') as tar:
        for member in tar.getmembers():
            if not member.isfile():
                continue
            name = member.name
            if not name.endswith('.tfm'):
                continue
            basename = os.path.basename(name)
            data = tar.extractfile(member).read()
            with open(os.path.join(pkg_dir, basename), 'wb') as f:
                f.write(data)
            out = os.path.join(dest_dir, basename)
            with open(out, 'wb') as f:
                f.write(data)
            count += 1
    print(f"    -> {count} TFM files extracted to texlive-packages/{pkg} and {os.path.relpath(dest_dir, ROOT)}")

def extract_map_enc(pkg, dest_dir):
    path = download(pkg)
    count = 0
    pkg_dir = os.path.join(ROOT, "texlive-packages", pkg)
    os.makedirs(pkg_dir, exist_ok=True)
    with tarfile.open(path, 'r:xz') as tar:
        for member in tar.getmembers():
            if not member.isfile():
                continue
            ext = os.path.splitext(member.name)[1].lower()
            if ext not in {'.map', '.enc'}:
                continue
            basename = os.path.basename(member.name)
            data = tar.extractfile(member).read()
            with open(os.path.join(pkg_dir, basename), 'wb') as f:
                f.write(data)
            out = os.path.join(dest_dir, basename)
            with open(out, 'wb') as f:
                f.write(data)
            # Shotgun approach for .enc files: web2c looks in 44 (enc) or 26 (tex)
            if ext == '.enc':
                for d in [DIR_26, os.path.join(ROOT, "texlive", "pdftex", "44")]:
                    os.makedirs(d, exist_ok=True)
                    with open(os.path.join(d, basename), 'wb') as f:
                        f.write(data)
            count += 1
    print(f"    -> {count} MAP/ENC files extracted to texlive-packages/{pkg} and {os.path.relpath(dest_dir, ROOT)}")

print("=== Fetching LaTeX kernel source files (format 26) ===")
extract_tex("latex", DIR_26)
extract_tex("l3kernel", DIR_26)
extract_tex("l3backend", DIR_26)
extract_tex("amsfonts", DIR_26)
extract_tex("amsmath", DIR_26)
extract_tex("amscls", DIR_26)
# glyphtounicode.tex: the LaTeX kernel replays it via \everyjob on pdfTeX < 1.40.22;
# without it \file_get:nnN yields \q_no_value and every compile hangs at job start.
extract_tex("pdftex", DIR_26)
extract_tex("graphics-def", DIR_26)
extract_tex("graphics-cfg", DIR_26)
extract_tex("epstopdf-pkg", DIR_26)

print("\n=== Fetching hyphenation files ===")
extract_tex("hyphen-base", DIR_26)

print("\n=== Fetching language files ===")
extract_tex("babel", DIR_26)

print("\n=== Fetching Unicode data files ===")
extract_tex("unicode-data", DIR_26)

print("\n=== Fetching handout addons ===")
extract_tex("multirow", DIR_26)
extract_tex("booktabs", DIR_26)
extract_tex("enumitem", DIR_26)
extract_tex("xcolor", DIR_26)
extract_tex("pgf", DIR_26)
extract_tex("etoolbox", DIR_26)
extract_tex("environ", DIR_26)
extract_tex("trimspaces", DIR_26)
extract_tex("tcolorbox", DIR_26)
extract_tex("textgreek", DIR_26)
extract_tex("greek-fontenc", DIR_26)
extract_tex("cbfonts-fd", DIR_26)
extract_tex("tools", DIR_26)

extract_tex("tikzfill", DIR_26)
extract_tex("pdfcol", DIR_26)
extract_tex("ltxcmds", DIR_26)
extract_tex("iftex", DIR_26)
extract_tex("pdftexcmds", DIR_26)
extract_tex("infwarerr", DIR_26)
extract_tex("kvoptions", DIR_26)
extract_tex("kvsetkeys", DIR_26)
extract_tex("kvdefinekeys", DIR_26)
extract_tex("etexcmds", DIR_26)
extract_tex("colortbl", DIR_26)
extract_tex("geometry", DIR_26)
extract_tex("atbegshi", DIR_26)
extract_tex("atveryend", DIR_26)
extract_tex("auxhook", DIR_26)
extract_tex("letltxmacro", DIR_26)
extract_tex("pdfescape", DIR_26)
extract_tex("listings", DIR_26)
extract_tex("listingsutf8", DIR_26)
extract_tex("stringenc", DIR_26)
extract_tex("tipa", DIR_26)
extract_tex("float", DIR_26)
extract_tex("uniquecounter", DIR_26)
extract_tex("rerunfilecheck", DIR_26)
extract_tex("bigintcalc", DIR_26)
extract_tex("bitset", DIR_26)
extract_tex("intcalc", DIR_26)
extract_tex("gettitlestring", DIR_26)
extract_tex("refcount", DIR_26)
extract_tex("hycolor", DIR_26)
extract_tex("hyperref", DIR_26)
extract_tex("url", DIR_26)
extract_tex("xurl", DIR_26)

print("\n=== Fetching CM + AMS Type 1 PFB fonts (format 32) ===")
extract_pfb("amsfonts", DIR_32)
extract_pfb("cm-super", DIR_32)
extract_pfb("cbfonts", DIR_32)
extract_pfb("tipa", DIR_32)
extract_map_enc("cm-super", DIR_11)


# Create minimal hyphen.cfg if not present
hyphen_cfg = os.path.join(DIR_26, "hyphen.cfg")
if not os.path.exists(hyphen_cfg):
    with open(hyphen_cfg, 'w') as f:
        f.write("\\input{hyphen.tex}\n")
    print("  Created minimal hyphen.cfg")
else:
    print("  hyphen.cfg already exists")

print("\n=== Fetching TFM font metrics (format 3) ===")
extract_tfm("latex-fonts", DIR_3)
extract_tfm("mflogo", DIR_3)
extract_tfm("cm", DIR_3)        # base Computer Modern metrics (cmr10, cmmi10, cmex10...)
extract_tfm("amsfonts", DIR_3)  # msam/msbm + cmextra (cmex7-9, cmbsy/cmmib small sizes) + euler
extract_tfm("cbfonts", DIR_3)
extract_tfm("ec", DIR_3)
extract_tfm("tipa", DIR_3)


print("\n=== Generating pdftex.map (format 11) from PFB fonts ===")
os.makedirs(DIR_11, exist_ok=True)
entries = []
for fname in sorted(os.listdir(DIR_32)):
    if not fname.endswith('.pfb'):
        continue
    with open(os.path.join(DIR_32, fname), 'rb') as f:
        data = f.read()
    m = re.search(rb'/FontName\s*/([^\s/]+)\s+def', data)
    if not m:
        print(f"  WARNING: no /FontName in {fname}, skipped")
        continue
    psname = m.group(1).decode('ascii')
    entries.append(f"{os.path.splitext(fname)[0]} {psname} <{fname}\n")
with open(os.path.join(DIR_11, "pdftex.map"), 'w', newline='\n', encoding='utf-8') as f:
    f.writelines(entries)
    # Append any other .map files found in DIR_11 (like cm-super maps)
    for mfile in sorted(os.listdir(DIR_11)):
        if mfile.endswith('.map') and mfile != "pdftex.map":
            with open(os.path.join(DIR_11, mfile), 'r', encoding='utf-8', errors='ignore') as inf:
                f.write(inf.read() + "\n")
print(f"    -> pdftex.map written with {len(entries)} entries and appended external maps")

print("\nDone.")
print("NOTE: after (re)fetching, rebuild the format via compile-format.html")
print("      (needs dev-server.js running) so the .fmt matches the sources.")
