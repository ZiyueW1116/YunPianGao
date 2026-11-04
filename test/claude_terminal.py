"""在独立 PTY 中启动正式终端入口；只处理合成账号的首次启动和信任提示。"""
import os,pty,re,select,signal,sys,time,fcntl,termios,struct

binary,plugin=sys.argv[1:]
pid,fd=pty.fork()
if pid==0:
    os.environ['TERM']='xterm-256color'
    os.environ['COLUMNS']='140'
    os.environ['LINES']='40'
    fcntl.ioctl(0,termios.TIOCSWINSZ,struct.pack('HHHH',40,140,0,0))
    os.execv(binary,[binary,'--plugin-dir',plugin,'--setting-sources','','--permission-mode','default','--model','claude-sonnet-4-6','--allowedTools','Bash','Read','TaskStop','mcp__yunpiangao__start_process','mcp__yunpiangao__wait_for','mcp__yunpiangao__cancel_task'])
def stop(_signum,_frame):
    try:os.kill(pid,signal.SIGTERM)
    except ProcessLookupError:pass
signal.signal(signal.SIGTERM,stop)
seen=set();buffer='';started=time.monotonic();ready_at=None
try:
    while time.monotonic()-started<40:
        if ready_at and time.monotonic()>=ready_at and 'ready' not in seen:
            seen.add('ready');os.write(sys.stdout.fileno(),b'\nYPG_TERMINAL_READY\n')
        readable,_,_=select.select([fd,sys.stdin],[],[],.1)
        if sys.stdin in readable:
            data=os.read(sys.stdin.fileno(),65536)
            if data:os.write(fd,data)
        if fd in readable:
            try:data=os.read(fd,65536)
            except OSError:break
            if not data:break
            os.write(sys.stdout.fileno(),data)
            buffer+=data.decode('utf8',errors='replace')
            plain=re.sub(r'\x1b\][^\x07]*(?:\x07|\x1b\\)','',buffer)
            plain=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',plain)
            compact=re.sub(r'\s+','',plain)
            for key,needle,response in [
                ('theme','Choosethetextstyle',b'\r'),
                ('key','DoyouwanttousethisAPIkey?',b'\x1b[A\r'),
                ('security','PressEntertocontinue',b'\r'),
                ('trust','Yes,Itrustthisfolder',b'\x1b[B\r')]:
                if key not in seen and needle in compact:
                    seen.add(key);time.sleep(.15);os.write(fd,response)
                    if key=='trust':ready_at=time.monotonic()+1
            if 'ready' not in seen and ('foragents' in compact or 'toCycle' in compact):
                seen.add('ready');os.write(sys.stdout.fileno(),b'\nYPG_TERMINAL_READY\n')
        ended,status=os.waitpid(pid,os.WNOHANG)
        if ended:sys.exit(os.waitstatus_to_exitcode(status))
finally:
    stop(None,None)
    try:os.waitpid(pid,0)
    except ChildProcessError:pass
    os.close(fd)
