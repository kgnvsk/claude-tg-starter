"""Pinned official Node runtime, installed as the agent, never system-wide."""
import hashlib, os, pathlib, platform, shutil, subprocess, tempfile, urllib.request

VERSION = '22.23.2'
destination = pathlib.Path.home() / '.local/lib/novsky-node'
binary = destination / 'bin/node'
if binary.is_file() and subprocess.run([str(binary),'--version'], capture_output=True, text=True).stdout.strip() == 'v'+VERSION:
    raise SystemExit(0)
arch = {'x86_64':'x64','aarch64':'arm64'}.get(platform.machine())
if not arch: raise SystemExit('Unsupported Node architecture')
name = 'node-v'+VERSION+'-linux-'+arch+'.tar.xz'
base = 'https://nodejs.org/dist/v'+VERSION+'/'
with urllib.request.urlopen(base+'SHASUMS256.txt',timeout=60) as response:
    sums=response.read(100000).decode()
expected=next((line.split()[0] for line in sums.splitlines() if line.split()[-1]==name),None)
if not expected: raise SystemExit('Node checksum unavailable')
destination.parent.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='novsky-node-',dir=destination.parent) as temporary:
    root=pathlib.Path(temporary); archive=root/name; digest=hashlib.sha256(); size=0
    with urllib.request.urlopen(base+name,timeout=120) as response, archive.open('wb') as out:
        while True:
            chunk=response.read(1024*1024)
            if not chunk: break
            size+=len(chunk)
            if size>100*1024*1024: raise SystemExit('Node archive too large')
            digest.update(chunk);out.write(chunk)
    if digest.hexdigest()!=expected: raise SystemExit('Node checksum mismatch')
    unpacked=root/'runtime';unpacked.mkdir()
    subprocess.run(['tar','-xJf',str(archive),'--strip-components=1','-C',str(unpacked)],check=True)
    if subprocess.run([str(unpacked/'bin/node'),'--version'],capture_output=True,text=True).stdout.strip()!='v'+VERSION: raise SystemExit('Node version mismatch')
    if destination.is_symlink(): raise SystemExit('Unexpected Node path')
    if destination.exists(): shutil.rmtree(destination)
    os.replace(unpacked,destination)
print('Agent-local Node '+VERSION+' verified')
