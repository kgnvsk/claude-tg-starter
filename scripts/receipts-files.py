#!/usr/bin/env python3
"""File boundary for receipts maintenance. Agent files are handled by the agent; secrets use stdin/stdout only."""
import fcntl,hashlib,json,os,pathlib,pwd,stat,sys,time

LIMIT=4*1024*1024
def regular(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        before=os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or before.st_uid!=os.geteuid():
            raise ValueError('unsafe agent file')
        data=b''
        while len(data)<=LIMIT:
            chunk=os.read(fd,65536)
            if not chunk:break
            data+=chunk
        if len(data)>LIMIT:raise ValueError('agent file too large')
        if identity(os.fstat(fd))!=identity(before):raise ValueError('agent file changed during read')
        return data,before
    finally:os.close(fd)

def identity(s):return s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns
def put(path,data,before):
    path=pathlib.Path(path);tmp=path.with_name('.receipts-'+os.urandom(16).hex())
    fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        with os.fdopen(fd,'wb') as f:
            os.fchmod(f.fileno(),stat.S_IMODE(before.st_mode));f.write(data);f.flush();os.fsync(f.fileno())
        if identity(os.lstat(path))!=identity(before):raise ValueError('agent file changed meanwhile')
        os.replace(tmp,path)
        d=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:os.fsync(d)
        finally:os.close(d)
    finally:
        try:tmp.unlink()
        except FileNotFoundError:pass

def rewrite(path,kind,old,new,expect=None,dry=False):
    data,before=regular(path)
    if expect and hashlib.sha256(data).hexdigest()!=expect:raise ValueError('env changed before switch')
    lines=data.decode().split('\n')
    if kind=='authority':
        if old not in ('shadow','receiver') or new not in ('shadow','receiver'):raise ValueError('invalid authority')
        hits=[i for i,l in enumerate(lines) if l.startswith('TG_DELIVERY_AUTHORITY=')]
        if len(hits)!=1 or lines[hits[0]]!='TG_DELIVERY_AUTHORITY='+old:raise ValueError('authority changed')
        lines[hits[0]]='TG_DELIVERY_AUTHORITY='+new
        changed='\n'.join(lines).encode()
    else:
        if new not in ('live','-'):raise ValueError('invalid engine mode')
        lines=[l for l in lines if not l.startswith(('OWNER_ENGINE=','CORPORATE_ENGINE='))]
        while lines and lines[-1]=='':lines.pop()
        if new=='live':lines+=['OWNER_ENGINE=live','CORPORATE_ENGINE=live']
        changed=('\n'.join(lines)+'\n').encode()
    if not dry:put(path,changed,before)
    return hashlib.sha256(changed).hexdigest()

def directory(path):
    """Open every parent by directory descriptor without following links."""
    path=pathlib.Path(path)
    if not path.is_absolute():raise ValueError('absolute directory required')
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=nxt
        return fd
    except BaseException:os.close(fd);raise

def new_backup(root,user):
    # Root controls this directory. Agent-owned folders never become backup roots.
    import tempfile
    parent=pathlib.Path(root)
    d=directory(parent.parent)
    try:
        try:os.mkdir(parent.name,0o700,dir_fd=d)
        except FileExistsError:pass
        fd=os.open(parent.name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=d)
        try:
            info=os.fstat(fd)
            if info.st_uid!=os.geteuid() or info.st_mode&0o022:raise ValueError('unsafe backup folder')
            name='receipts-'+user+'-'+os.urandom(16).hex()
            os.mkdir(name,0o700,dir_fd=fd);os.fsync(fd)
        finally:os.close(fd)
    finally:os.close(d)
    return str(parent/name)

def lock_run(path,user,command):
    expected=pwd.getpwnam(user).pw_uid
    d=directory(pathlib.Path(path).parent)
    try:fd=os.open(pathlib.Path(path).name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=d)
    finally:os.close(d)
    try:
        s=os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid!=expected or s.st_nlink!=1:raise ValueError('unsafe lifecycle lock')
        deadline=time.monotonic()+60
        while True:
            try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);break
            except BlockingIOError:
                if time.monotonic()>=deadline:raise ValueError('lifecycle lock busy')
                time.sleep(.1)
        # FD survives this exec and belongs to the same operation until the switch ends.
        os.set_inheritable(fd,True);os.environ['RECEIPTS_LOCK_FD']=str(fd)
        os.execv(command[0],command)
    finally:os.close(fd)

def main(a):
    op,path=a[:2]
    if op=='read':sys.stdout.buffer.write(regular(path)[0])
    elif op=='hash':print(hashlib.sha256(regular(path)[0]).hexdigest())
    elif op=='value':
        if a[2] not in ['TG_DELIVERY_AUTHORITY','OWNER_ENGINE','CORPORATE_ENGINE']:raise ValueError('not a public mode')
        lines=[line.partition('=')[2] for line in regular(path)[0].decode().splitlines() if line.startswith(a[2]+'=')]
        if len(lines)!=1 or lines[0] not in ['shadow','receiver','live','interactive','']:return 1
        print(lines[0])
    elif op=='new-backup':print(new_backup(path,a[2]))
    elif op=='save-backup':
        data=sys.stdin.buffer.read(LIMIT+1)
        if len(data)>LIMIT:raise ValueError('backup too large')
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'wb') as out:os.fchmod(out.fileno(),0o600);out.write(data);out.flush();os.fsync(out.fileno())
        d=directory(pathlib.Path(path).parent)
        try:os.fsync(d)
        finally:os.close(d)
        print(hashlib.sha256(data).hexdigest())
    elif op in ('authority','plan-authority'):print(rewrite(path,'authority',*a[2:4],expect=a[4] if len(a)>4 else None,dry=op.startswith('plan-')))
    elif op in ('engines','plan-engines'):print(rewrite(path,'engines','',a[2],expect=a[3] if len(a)>3 else None,dry=op.startswith('plan-')))
    elif op=='restore':
        data,before=regular(path)
        if hashlib.sha256(data).hexdigest()!=a[2]:raise ValueError('env changed after this operation')
        replacement=sys.stdin.buffer.read(LIMIT+1)
        if len(replacement)>LIMIT:raise ValueError('backup too large')
        put(path,replacement,before)
    elif op=='ensure-lock':
        try:
            fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);os.close(fd)
        except FileExistsError:pass
        regular(path)
    elif op=='lock-run':lock_run(path,a[2],a[3:])
    elif op=='lock-check':
        info=os.fstat(int(a[2]));expected=pwd.getpwnam(a[3]).pw_uid
        d=directory(pathlib.Path(path).parent)
        try:now=os.stat(pathlib.Path(path).name,dir_fd=d,follow_symlinks=False)
        finally:os.close(d)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_uid!=expected or (info.st_dev,info.st_ino)!=(now.st_dev,now.st_ino):raise ValueError('lifecycle lock changed')
        fcntl.flock(int(a[2]),fcntl.LOCK_EX|fcntl.LOCK_NB)
    elif op=='hold':
        try:data,before=regular(path)
        except FileNotFoundError:data=b'0';before=None
        if not data.strip().isdigit() or int(data)>int(time.time()):raise ValueError('another restart hold exists')
        if before is None:
            fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            with os.fdopen(fd,'wb') as out:out.write((a[2]+'\n').encode());out.flush();os.fsync(out.fileno())
        else:put(path,(a[2]+'\n').encode(),before)
    elif op=='unhold':
        try:data,_=regular(path)
        except FileNotFoundError:return 0
        if data.strip()==a[2].encode():os.unlink(path)
    elif op=='inspect':
        _,s=regular(path);print(json.dumps({'dev':s.st_dev,'ino':s.st_ino,'uid':s.st_uid,'gid':s.st_gid,'mode':stat.S_IMODE(s.st_mode)}))
    elif op=='mode':
        expected=json.loads(a[2]);fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            s=os.fstat(fd)
            if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_uid!=os.geteuid() or (s.st_dev,s.st_ino)!=(expected['dev'],expected['ino']):raise ValueError('selector changed')
            os.fchmod(fd,int(a[3]))
        finally:os.close(fd)
    else:raise ValueError('unknown file operation')
    return 0

if __name__=='__main__':
    try:sys.exit(main(sys.argv[1:]))
    except (OSError,ValueError,KeyError):sys.exit('receipts file check refused; no unsafe file was written')
