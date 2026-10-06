#!/usr/bin/env python3
"""Install the public offline renderer. Never export an owner's environment."""
from __future__ import annotations
import argparse,hashlib,json,os,pathlib,secrets,stat,subprocess,time
PREFIX=pathlib.Path('/usr/local/lib/novsky-artifacts')
PACKAGE_LOG=pathlib.Path('/root/backups/novsky-artifacts')
PACKAGES=('libreoffice-writer','libreoffice-impress','libreoffice-calc','poppler-utils','fonts-dejavu-core','bubblewrap')
BOOTSTRAP=b'''#!/usr/bin/env python3
import hashlib,json,os,pathlib,runpy,stat
p=pathlib.Path(__file__).parent
fd=os.open(p/'CURRENT.json',os.O_RDONLY|os.O_NOFOLLOW)
with os.fdopen(fd) as f:info=os.fstat(f.fileno());m=json.load(f)
if info.st_uid not in (0,65534) or info.st_uid==os.geteuid() or info.st_mode&0o022:raise SystemExit('Unsafe renderer manifest')
v=m.get('version','')
if len(v)!=64 or any(c not in '0123456789abcdef' for c in v):raise SystemExit('Invalid renderer version')
s=p/'versions'/v/'artifact-render.py'
fd=os.open(s,os.O_RDONLY|os.O_NOFOLLOW)
with os.fdopen(fd,'rb') as f:info=os.fstat(f.fileno());data=f.read(256*1024)
if info.st_uid not in (0,65534) or info.st_uid==os.geteuid() or info.st_mode&0o022 or hashlib.sha256(data).hexdigest()!=m.get('helperSha256'):raise SystemExit('Renderer source changed')
runpy.run_path(str(s),run_name='__main__')
'''
class InstallError(ValueError):pass

def directory(path,create=False):
 fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
 try:
  for part in pathlib.Path(path).parts[1:]:
   if create:
    try:os.mkdir(part,0o755,dir_fd=fd)
    except FileExistsError:pass
   child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
   s=os.fstat(child)
   if s.st_uid!=0 or s.st_mode&0o022:os.close(child);raise InstallError('unsafe public directory')
   os.close(fd);fd=child
  return fd
 except BaseException:os.close(fd);raise

def read_at(fd,name,limit=32*1024*1024):
 try:f=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
 except FileNotFoundError:return None
 try:
  s=os.fstat(f)
  if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_nlink!=1 or s.st_mode&0o022 or s.st_size>limit:raise InstallError('unsafe public file')
  out=b''
  while len(out)<=limit:
   b=os.read(f,min(1024*1024,limit+1-len(out)))
   if not b:return out
   out+=b
  raise InstallError('public file too large')
 finally:os.close(f)

def write_at(fd,name,data,mode=0o444):
 leaf='.'+name+'.'+secrets.token_hex(10)
 f=os.open(leaf,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode,dir_fd=fd)
 try:
  with os.fdopen(f,'wb') as out:os.fchmod(out.fileno(),mode);out.write(data);out.flush();os.fsync(out.fileno())
  os.rename(leaf,name,src_dir_fd=fd,dst_dir_fd=fd);os.fsync(fd)
 finally:
  try:os.unlink(leaf,dir_fd=fd)
  except FileNotFoundError:pass

def public_files(root,allowed,exclude_samples=False):
 result={};total=0
 def visit(current,relative):
  nonlocal total
  # Distribution LDAP examples are documentation, never active LO configuration.
  if exclude_samples and current.name.endswith('.sample'):return
  actual=current.resolve(strict=True)
  if not any(actual==p or p in actual.parents for p in allowed):raise InstallError('system configuration link escapes public roots')
  s=actual.stat()
  if s.st_uid!=0 or s.st_mode&0o022:raise InstallError('system configuration is not root managed')
  allowed_root=next(p for p in allowed if actual==p or p in actual.parents)
  for parent in (actual.parent,*actual.parents):
   if parent==allowed_root or allowed_root in parent.parents:
    entry=parent.stat()
    if entry.st_uid!=0 or entry.st_mode&0o022 or entry.st_mode&0o005!=0o005:raise InstallError('system configuration directory is private')
  if stat.S_ISDIR(s.st_mode) and s.st_mode&0o005!=0o005:raise InstallError('system configuration directory is private')
  if stat.S_ISREG(s.st_mode) and not s.st_mode&0o004:raise InstallError('system configuration file is private')
  if actual.is_dir():
   for p in sorted(actual.iterdir()):visit(p,relative/p.name)
  elif stat.S_ISREG(s.st_mode):
   data=actual.read_bytes();total+=len(data)
   if total>32*1024*1024 or len(result)>=1024:raise InstallError('system configuration exceeds budget')
   result[relative.as_posix()]=data
  else:raise InstallError('unexpected public configuration type')
 visit(root,pathlib.Path('.'));return result

def verify_previous(prefix,meta):
 version=meta.get('version','')
 if not isinstance(version,str) or len(version)!=64 or any(c not in '0123456789abcdef' for c in version):raise InstallError('old public version invalid')
 root=prefix/'versions'/version;parent=directory(root)
 try:encoded=read_at(parent,'manifest.json',128*1024)
 finally:os.close(parent)
 if encoded is None or hashlib.sha256(encoded).hexdigest()!=version:raise InstallError('old immutable manifest changed')
 manifest=json.loads(encoded)
 if not isinstance(manifest,dict) or len(manifest)>1024:raise InstallError('old immutable manifest invalid')
 for name,expected in manifest.items():
  if not isinstance(name,str) or name.startswith('/') or any(part in ['.','..',''] for part in name.split('/')):raise InstallError('old immutable path invalid')
  path=root/name;folder=directory(path.parent)
  try:data=read_at(folder,path.name)
  finally:os.close(folder)
  if data is None or hashlib.sha256(data).hexdigest()!=expected:raise InstallError('old immutable renderer has a local edit')
 if manifest.get('artifact-render.py')!=meta.get('helperSha256'):raise InstallError('old renderer identity invalid')

def process_start(pid):
 try:text=pathlib.Path('/proc')/str(pid)/'stat';data=text.read_text()
 except (FileNotFoundError,ProcessLookupError):return None
 fields=data[data.rindex(')')+2:].split()
 return int(fields[19])

def active_package_job():
 if not PACKAGE_LOG.exists():return
 folder=directory(PACKAGE_LOG)
 try:
  for name in os.listdir(folder):
   if not name.endswith('.process.json'):continue
   data=read_at(folder,name,128*1024);meta=json.loads(data)
   if list(meta.get('packages',[]))!=list(PACKAGES):continue
   pid=meta.get('pid');stamp=meta.get('starttime')
   if not isinstance(pid,int) or pid<2 or not isinstance(stamp,int):raise InstallError('package job identity unreadable')
   if process_start(pid)==stamp:raise InstallError('recorded package installation still running')
 finally:os.close(folder)

def ensure_packages():
 active_package_job()
 env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','DEBIAN_FRONTEND':'noninteractive','NEEDRESTART_MODE':'l'}
 states=subprocess.run(['dpkg-query','-W','-f=${db:Status-Status}\n',*PACKAGES],env=env,capture_output=True,text=True,timeout=20)
 if states.returncode==0 and states.stdout.splitlines()==['installed']*len(PACKAGES):return
 plan=subprocess.run(['apt-get','-s','--no-upgrade','--no-install-recommends','install',*PACKAGES],env=env,capture_output=True,text=True,timeout=90)
 if plan.returncode or not any(s.startswith('0 upgraded,') and '0 to remove' in s for s in plan.stdout.splitlines()):raise InstallError('package plan changes existing packages')
 job='novsky-artifact-packages-'+secrets.token_hex(8)
 backup=directory(PACKAGE_LOG,create=True)
 try:
  os.fchmod(backup,0o700)
  record=json.dumps({'job':job,'packages':PACKAGES,'before':states.stdout,'plan':plan.stdout}).encode()
  write_at(backup,job+'.json',record,0o600)
 finally:os.close(backup)
 if not pathlib.Path('/run/systemd/system').is_dir():
  # Container installs have no systemd. A bounded wait must never kill dpkg:
  # leave the recorded package job in its own session with a private log.
  folder=directory(PACKAGE_LOG)
  try:
   log=os.open(job+'.log',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=folder)
   try:child=subprocess.Popen(['apt-get','-y','--no-upgrade','--no-install-recommends','install',*PACKAGES],env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
   finally:os.close(log)
   write_at(folder,job+'.process.json',json.dumps({'pid':child.pid,'starttime':process_start(child.pid),'packages':PACKAGES,'startedAt':time.time()}).encode(),0o600)
  finally:os.close(folder)
  try:code=child.wait(timeout=600)
  except subprocess.TimeoutExpired:raise InstallError('recorded package installation still running; do not repeat until it finishes')
  if code:raise InstallError('renderer packages unavailable')
  return
 started=subprocess.run(['systemd-run','--no-block','--quiet','--unit',job,'--property=Type=oneshot','--property=RemainAfterExit=yes','/usr/bin/env','DEBIAN_FRONTEND=noninteractive','NEEDRESTART_MODE=l','/usr/bin/apt-get','-y','--no-upgrade','--no-install-recommends','install',*PACKAGES],env=env,capture_output=True,timeout=20)
 if started.returncode:raise InstallError('package installation was not started')
 for unused in range(120):
  state=subprocess.run(['systemctl','show',job,'-p','Result','-p','SubState','-p','ExecMainStatus'],env=env,capture_output=True,text=True,timeout=10)
  fields=dict(line.split('=',1) for line in state.stdout.splitlines() if '=' in line)
  if fields.get('SubState') in ['exited','dead','failed']:
   if fields.get('Result')=='success' and fields.get('ExecMainStatus')=='0':return
   raise InstallError('renderer packages unavailable')
  time.sleep(5)
 # The recorded systemd job remains alive. Never kill an apt/dpkg transaction.
 raise InstallError('package installation still running; repeat after the recorded job finishes')

def install(helper,prefix=PREFIX):
 if os.geteuid()!=0:raise InstallError('public renderer installation needs the server administrator')
 payload={'artifact-render.py':helper}
 for src,dest,roots in [(pathlib.Path('/etc/libreoffice/registry'),'registry',[pathlib.Path('/etc/libreoffice')]),(pathlib.Path('/etc/fonts'),'fonts',[pathlib.Path('/etc/fonts'),pathlib.Path('/usr/share/fontconfig')])]:
  for rel,data in public_files(src,roots,exclude_samples=dest=='registry').items():payload[dest+'/'+rel]=data
 manifest={name:hashlib.sha256(data).hexdigest() for name,data in sorted(payload.items())}
 encoded=(json.dumps(manifest,sort_keys=True,separators=(',',':'))+'\n').encode();version=hashlib.sha256(encoded).hexdigest()
 parent=directory(prefix,create=True)
 try:
  current=read_at(parent,'CURRENT.json');wrapper=read_at(parent,'render.py')
  if wrapper is not None and wrapper!=BOOTSTRAP:raise InstallError('local public renderer edit retained')
  if current is not None:
   old=json.loads(current)
   if set(old)!={'schemaVersion','version','helperSha256'} or old['schemaVersion']!=1:raise InstallError('old public manifest invalid')
   verify_previous(prefix,old)
  meta=(json.dumps({'schemaVersion':1,'version':version,'helperSha256':manifest['artifact-render.py']},sort_keys=True)+'\n').encode()
  if meta!=current:
   backup=directory(PACKAGE_LOG,create=True)
   try:
    os.fchmod(backup,0o700)
    record={'prefix':str(prefix),'current':None if current is None else current.decode(),'wrapperSha256':None if wrapper is None else hashlib.sha256(wrapper).hexdigest(),'targetVersion':version}
    write_at(backup,'preimage-'+secrets.token_hex(12)+'.json',json.dumps(record).encode(),0o600)
   finally:os.close(backup)
  for name,data in {**payload,'manifest.json':encoded}.items():
   path=prefix/'versions'/version/name;folder=directory(path.parent,create=True)
   try:
    previous=read_at(folder,path.name)
    if previous is None:write_at(folder,path.name,data)
    elif previous!=data:raise InstallError('immutable public version changed')
   finally:os.close(folder)
  if wrapper is None:write_at(parent,'render.py',BOOTSTRAP,0o555)
  meta=(json.dumps({'schemaVersion':1,'version':version,'helperSha256':manifest['artifact-render.py']},sort_keys=True)+'\n').encode()
  if read_at(parent,'CURRENT.json')!=current:raise InstallError('public version changed during preparation')
  if meta!=current:
   write_at(parent,'CURRENT.json',meta)
  return {'ok':True,'version':version,'files':len(payload),'publicConfigurationOnly':True}
 finally:os.close(parent)

if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--install',action='store_true');p.add_argument('--plugins-file',type=pathlib.Path);args=p.parse_args()
 try:
  if args.plugins_file is not None:
   contract=json.loads(args.plugins_file.read_text());plugins=contract.get('nativePlugins',contract.get('enabled'))
   if not isinstance(plugins,list) or any(not isinstance(item,str) for item in plugins):raise InstallError('invalid plugin contract')
   if not any(item.startswith('document-skills@') for item in plugins):print(json.dumps({'ok':True,'skipped':'document-tools-not-declared'}));raise SystemExit(0)
  if args.install:ensure_packages()
  helper=pathlib.Path(__file__).with_name('artifact-render.py').read_bytes()
  print(json.dumps(install(helper)))
 except (OSError,ValueError,subprocess.SubprocessError):print(json.dumps({'ok':False,'reason':'Public artifact tools could not be prepared; existing agent data was not changed.'}));raise SystemExit(1)
