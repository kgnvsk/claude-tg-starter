#!/usr/bin/env python3
"""Render one workspace Office/PDF file offline, without access to the host's data."""
from __future__ import annotations
import argparse,hashlib,json,os,pathlib,resource,signal,stat,subprocess,tempfile
PUBLIC=pathlib.Path('/usr/local/lib/novsky-artifacts')
MAX_INPUT=50*1024*1024
class RenderError(ValueError):pass

def safe_read(path,limit,owner,dir_fd=None):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=dir_fd)
 try:
  before=os.fstat(fd)
  if not stat.S_ISREG(before.st_mode) or before.st_uid!=owner or before.st_nlink!=1 or before.st_size>limit:raise RenderError('unsafe or oversized file')
  chunks=[];total=0
  while True:
   b=os.read(fd,min(1024*1024,limit+1-total))
   if not b:break
   total+=len(b)
   if total>limit:raise RenderError('oversized file')
   chunks.append(b)
  after=os.fstat(fd)
  if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns):raise RenderError('source changed while being read')
  return b''.join(chunks)
 finally:os.close(fd)

def relative_source(cwd,name):
 parts=pathlib.PurePosixPath(name).parts
 if not parts or name.startswith('/') or any(p in ('..','.') for p in name.split('/')):raise RenderError('source must be a relative workspace file')
 path=cwd
 for part in parts:
  path=path/part
  if path.is_symlink():raise RenderError('linked source refused')
 return path

def workspace_source(cwd,name):
 relative_source(cwd,name)  # validate the grammar before opening anything
 parts=pathlib.PurePosixPath(name).parts
 parent=os.open(cwd,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  for part in parts[:-1]:
   child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
   os.close(parent);parent=child
   info=os.fstat(parent)
   if info.st_uid!=os.geteuid() or info.st_mode&0o022:raise RenderError('unsafe source directory')
  return safe_read(parts[-1],MAX_INPUT,os.geteuid(),dir_fd=parent)
 finally:os.close(parent)

def public_configuration(public=PUBLIC):
 owner=public.lstat().st_uid
 if owner not in (0,65534) or owner==os.geteuid():raise RenderError('renderer configuration unsafe')
 meta=json.loads(safe_read(public/'CURRENT.json',128*1024,owner))
 if set(meta)!={'schemaVersion','version','helperSha256'} or meta['schemaVersion']!=1:raise RenderError('renderer configuration invalid')
 version=meta['version']
 if not isinstance(version,str) or len(version)!=64 or any(c not in '0123456789abcdef' for c in version):raise RenderError('renderer configuration invalid')
 config=public/'versions'/version
 for path in [public,public/'versions',config]:
  info=path.lstat()
  if not stat.S_ISDIR(info.st_mode) or info.st_uid!=owner or info.st_mode&0o022:raise RenderError('renderer configuration unsafe')
 encoded=safe_read(config/'manifest.json',128*1024,owner)
 if hashlib.sha256(encoded).hexdigest()!=version:raise RenderError('renderer manifest changed')
 manifest=json.loads(encoded)
 if not isinstance(manifest,dict) or len(manifest)>1024 or manifest.get('artifact-render.py')!=meta['helperSha256']:raise RenderError('renderer manifest invalid')
 for name,digest in manifest.items():
  target=relative_source(config,name);data=safe_read(target,16*1024*1024,owner)
  if hashlib.sha256(data).hexdigest()!=digest:raise RenderError('renderer configuration changed')
 return config

def offline_command(work,args,config):
 # Only the immutable public renderer configuration and this one input/output
 # directory are available. No account, vault, other workspace or network.
 box=['/usr/bin/bwrap','--unshare-user','--unshare-pid','--unshare-net','--die-with-parent','--ro-bind','/','/','--proc','/proc','--dev','/dev']
 for path in ['/home','/root','/opt','/srv','/var','/run','/tmp','/etc']:box+=['--tmpfs',path]
 for path in ['/etc/ld.so.cache','/etc/localtime','/etc/passwd','/etc/group']:
  if os.path.exists(path):box+=['--ro-bind',path,path]
 box+=['--ro-bind',str(config),str(config),'--bind',str(work),str(work),'--chdir',str(work),'--']
 env={'PATH':'/usr/local/bin:/usr/bin:/bin','LANG':'C.UTF-8','HOME':str(work),'TMPDIR':str(work/'tmp'),'XDG_CACHE_HOME':str(work/'cache'),'SAL_USE_VCLPLUGIN':'svp','FONTCONFIG_FILE':str(config/'fonts/fonts.conf'),'FONTCONFIG_PATH':str(config/'fonts')}
 def limits():
  resource.setrlimit(resource.RLIMIT_CPU,(100,100));resource.setrlimit(resource.RLIMIT_AS,(2*1024**3,2*1024**3));resource.setrlimit(resource.RLIMIT_FSIZE,(100*1024**2,100*1024**2));resource.setrlimit(resource.RLIMIT_NOFILE,(256,256))
 child=subprocess.Popen(box+args,env=env,cwd=work,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,preexec_fn=limits)
 try:child.communicate(timeout=120)
 except subprocess.TimeoutExpired:
  os.killpg(child.pid,signal.SIGKILL);child.communicate(timeout=15);raise RenderError('rendering time limit exceeded')
 if child.returncode:raise RenderError('renderer failed; source retained')

def render(name,cwd=None,public=PUBLIC):
 if os.geteuid()==0:raise RenderError('run as the agent, never root')
 cwd=pathlib.Path.cwd() if cwd is None else pathlib.Path(cwd)
 if cwd.is_symlink() or cwd.resolve()!=cwd or cwd.stat().st_uid!=os.geteuid():raise RenderError('workspace is not owned by the caller')
 source=relative_source(cwd,name);ext=source.suffix.lower()
 if ext not in ['.docx','.pptx','.xlsx','.pdf']:raise RenderError('use docx, pptx, xlsx or pdf')
 data=workspace_source(cwd,name);config=public_configuration(public)
 work=pathlib.Path(tempfile.mkdtemp(prefix='.artifact-render-',dir=cwd));os.chmod(work,0o700)
 for name in ['tmp','cache','out']:(work/name).mkdir(mode=0o700)
 target=work/('source'+ext);target.write_bytes(data);target.chmod(0o600)
 out=work/'out';pdf=out/'source.pdf';verified=False
 try:
  if ext=='.pdf':pdf.write_bytes(data);pdf.chmod(0o600)
  else:
   uri=config.as_uri();profile=(work/'profile').as_uri()
   layers='xcsxcu:'+uri+'/registry res:'+uri+'/registry user:!'+profile+'/user/registrymodifications.xcu'
   offline_command(work,['/usr/bin/libreoffice','-env:CONFIGURATION_LAYERS='+layers,'-env:UserInstallation='+profile,'--headless','--convert-to','pdf','--outdir',str(out),str(target)],config)
  pdf_data=safe_read(pdf,100*1024**2,os.geteuid())
  if not pdf_data.startswith(b'%PDF-'):raise RenderError('renderer produced no PDF')
  offline_command(work,['/usr/bin/pdftoppm','-f','1','-singlefile','-scale-to','1600','-png',str(pdf),str(out/'preview')],config)
  preview=out/'preview.png';preview_data=safe_read(preview,32*1024**2,os.geteuid())
  if not preview_data.startswith(b'\x89PNG\r\n\x1a\n'):raise RenderError('renderer produced no preview')
  for path in [pdf,preview]:path.chmod(0o600)
  verified=True
  return {'ok':True,'inputSha256':hashlib.sha256(data).hexdigest(),'pdf':str(pdf.relative_to(cwd)),'pdfSha256':hashlib.sha256(pdf_data).hexdigest(),'preview':str(preview.relative_to(cwd)),'previewSha256':hashlib.sha256(preview_data).hexdigest(),'offline':True}
 finally:
  # The untrusted source and private profile are temporary; only verified
  # outputs remain in the workspace for inspection and reply_file.
  import shutil
  target.unlink(missing_ok=True)
  for directory in ['tmp','cache','profile']:shutil.rmtree(work/directory,ignore_errors=True)
  if not verified:shutil.rmtree(work,ignore_errors=True)

if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('source');args=p.parse_args()
 try:print(json.dumps(render(args.source)))
 except (OSError,ValueError,subprocess.SubprocessError):print(json.dumps({'ok':False,'reason':'Rendering unavailable or refused. The original file is retained; check the source, workspace and installed artifact tools.'}));raise SystemExit(1)
