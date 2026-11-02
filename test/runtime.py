"""真实 OpenCode 入口的合成调度检查；不接外部模型，不读已有会话库。"""
import base64,http.server,json,os,re,shutil,socket,sqlite3,subprocess,tempfile,threading,time,urllib.request
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
SUMMARY='''## Objective
- SYNTHETIC_CHECKPOINT：继续合成会话。
## Requirements
- 新输入优先。
## Decisions
- 仅做本地调度检查。
## Work State
- 第一轮已完成。
## Next Move
1. 处理下一轮。
## Relevant Files
- 无。
## Important Context
- 合成输出不能证明真实模型摘要保真度。
'''

def wait(check,timeout=15):
    start=time.monotonic()
    while time.monotonic()-start<timeout:
        value=check()
        if value:return value
        time.sleep(.02)
    raise TimeoutError('合成调度检查超时')

def run_case(name):
    with_task=name=='prepared-task'
    with tempfile.TemporaryDirectory(prefix='yunpiangao-synthetic-') as td:
        root=Path(td).resolve();workspace=root/'workspace';workspace.mkdir();runtime=root/'runtime';runtime.mkdir()
        for folder in ['config','data','state','cache']:(runtime/folder).mkdir()
        calls=[];release=threading.Event();started=threading.Event()
        if name!='race':release.set()
        class Provider(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                body=json.loads(self.rfile.read(int(self.headers['content-length'])))
                kind=self.headers.get('x-yunpiangao-test-kind','primary')
                history=json.dumps(body.get('messages',[]),ensure_ascii=False)
                calls.append({'kind':kind,'during_prepare':started.is_set() and not release.is_set(),'dependencies':'云片糕任务运行时状态' in history,'task_handle':'ypg_' in history})
                if kind=='generate':
                    started.set();release.wait(10)
                    if name=='failure':self.send_error(400,'Synthetic failure');return
                primary=sum(x['kind']=='primary' for x in calls)
                hot=name!='below' and kind=='primary' and primary==(2 if with_task else 1)
                usage={'prompt_tokens':490000 if hot else 1000,'completion_tokens':10,'total_tokens':490010 if hot else 1010}
                text=SUMMARY if kind in ['generate','compaction'] else '合成回复：当前轮已完成。'
                data={'id':'synthetic','model':body['model'],'created':0}
                tool=with_task and kind=='primary' and primary==1
                delta={'role':'assistant','content':text}
                if tool:
                    code='from pathlib import Path; import time; Path("task-started").touch(); p=Path("task-release");\nwhile not p.exists(): time.sleep(.02)\nPath("task-completed").touch()'
                    delta={'role':'assistant','tool_calls':[{'index':0,'id':'call_register','type':'function','function':{'name':'start_process','arguments':json.dumps({'command':shutil.which('python3'),'args':['-c',code]})}}]}
                self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
                for finish,delta in [(None,delta),('tool_calls' if tool else 'stop',{})]:
                    self.wfile.write(('data: '+json.dumps({**data,'choices':[{'index':0,'delta':delta,'finish_reason':finish}]})+'\n\n').encode())
                self.wfile.write(('data: '+json.dumps({**data,'choices':[],'usage':usage})+'\n\ndata: [DONE]\n\n').encode())
        provider=http.server.ThreadingHTTPServer(('127.0.0.1',0),Provider)
        thread=threading.Thread(target=provider.serve_forever,daemon=True);thread.start()
        with socket.socket() as reserve:reserve.bind(('127.0.0.1',0));port=reserve.getsockname()[1]
        config={
          'compaction':{'auto':True,'keep':{'tokens':20000},'buffer':60000},
          'experimental':{'background_compaction':False},
          'plugins':[{'package':str(ROOT/'test/observer'),'options':{'events':str(runtime/'events.jsonl')}},
                     {'package':str(ROOT),'options':{'thresholdTokens':480000,'idleDelayMs':30,'strategy':'direct' if name=='direct' else 'prepare-then-commit'}}],
          'providers':{'synthetic':{'name':'本地合成替身','package':'@opencode/ai/providers/openai-compatible',
             'settings':{'baseURL':f'http://127.0.0.1:{provider.server_port}/v1','apiKey':'synthetic-only'},
             'models':{'synthetic':{'limit':{'context':600000,'output':384000}}}}}}
        (runtime/'config/opencode.json').write_text(json.dumps(config))
        env=dict(os.environ,OPENCODE_CONFIG_DIR=str(runtime/'config'),XDG_CONFIG_HOME=str(runtime/'config'),
                 XDG_DATA_HOME=str(runtime/'data'),XDG_STATE_HOME=str(runtime/'state'),XDG_CACHE_HOME=str(runtime/'cache'),
                 OPENCODE_DISABLE_MODELS_FETCH='true',NO_COLOR='1')
        log=(runtime/'server.log').open('wb');proc=None
        def events():
            p=runtime/'events.jsonl'
            if not p.exists():return []
            result=[]
            for line in p.read_text().splitlines():
                try:result.append(json.loads(line))
                except ValueError:pass
            return result
        def finished():return sum(x['type']=='session.step.ended' and x.get('finish')=='stop' for x in events())
        def compactions():return sum(x['type']=='session.compaction.ended' for x in events())
        try:
            executable=os.environ.get('OPENCODE_BIN') or shutil.which('opencode')
            if not executable:raise RuntimeError('请先安装 OpenCode 2.1.4，或用 OPENCODE_BIN 指定隔离的二进制。')
            proc=subprocess.Popen([executable,'serve','--hostname','127.0.0.1','--port',str(port)],cwd=workspace,env=env,stdout=log,stderr=subprocess.STDOUT)
            found=wait(lambda:re.search(r'server password (\S+)',(runtime/'server.log').read_text(errors='replace')))
            auth=base64.b64encode(('opencode:'+found[1]).encode()).decode()
            def api(method,path,body=None):
                req=urllib.request.Request(f'http://127.0.0.1:{port}'+path,
                    data=json.dumps(body).encode() if body is not None else None,method=method,
                    headers={'Authorization':'Basic '+auth,'Content-Type':'application/json'})
                with urllib.request.urlopen(req,timeout=10) as response:return json.load(response)
            session=api('POST','/api/session',{'title':'合成测试','location':{'directory':str(workspace)},'model':{'providerID':'synthetic','id':'synthetic'}})['data']
            sid=session['id'];api('POST',f'/api/session/{sid}/prompt',{'text':'合成第一轮，请只回复一句话。'})
            wait(lambda:finished()>=1)
            if name=='race':
                wait(started.is_set)
                api('POST',f'/api/session/{sid}/prompt',{'text':'合成第二轮：新输入已经到达。'})
                wait(lambda:finished()>=2)
                assert any(x['kind']=='primary' and x['during_prepare'] for x in calls)
                release.set();time.sleep(.3);assert compactions()==0
            elif name in ['prepared','prepared-task','direct']:
                wait(lambda:compactions()==1)
                api('POST',f'/api/session/{sid}/prompt',{'text':'合成第二轮，请继续。'})
                wait(lambda:finished()>=2);time.sleep(.2);assert compactions()==1
            else:
                time.sleep(.4);assert compactions()==0
                api('POST',f'/api/session/{sid}/prompt',{'text':'合成第二轮，请继续。'})
                wait(lambda:finished()>=2)
            data=api('GET',f'/api/experimental/session/{sid}/export?sanitize=false')['data']
            users=[m for m in data['messages'] if m['type']=='user'];assert len(users)==2
            assert all('YUNPIANGAO_PREPARE_' not in m['text'] for m in users)
            if name in ['prepared','prepared-task','direct']:
                compacted=[m for m in data['messages'] if m['type']=='compaction' and m['status']=='completed']
                assert len(compacted)==1 and 'SYNTHETIC_CHECKPOINT' in compacted[0]['summary']
            if name in ['prepared','prepared-task']:assert sum(x['kind']=='generate' for x in calls)==1 and not any(x['kind']=='compaction' for x in calls)
            if with_task:
                assert any(e['type']=='session.tool.success' and e.get('id')=='call_register' for e in events())
                assert all(call['task_handle'] for call in calls if call['kind']=='generate')
                assert calls[-1]['kind']=='primary' and calls[-1]['dependencies']
                assert (workspace/'task-started').exists() and not (workspace/'task-completed').exists()
            if name=='failure':assert sum(x['kind']=='generate' for x in calls)==1
            if name=='direct':assert sum(x['kind']=='compaction' for x in calls)==1 and not any(x['kind']=='generate' for x in calls)
        except BaseException:
            print('合成检查诊断',json.dumps({'case':name,'calls':calls,'events':events()},ensure_ascii=False))
            lines=(runtime/'server.log').read_text(errors='replace').splitlines()
            print('合成进程诊断','\n'.join(re.sub(r'server password \S+','server password [redacted]',line) for line in lines if 'YunPianGao' in line or 'error' in line.lower())[-6000:])
            raise
        finally:
            release.set()
            if with_task:
                (workspace/'task-release').touch()
            if proc:
                proc.terminate()
                try:proc.wait(10)
                except subprocess.TimeoutExpired:proc.kill();proc.wait()
            log.close();provider.shutdown();provider.server_close();thread.join()
        if with_task:wait(lambda:(workspace/'task-completed').exists())
        db=runtime/'data/opencode/opencode.db'
        assert db.is_relative_to(root) and db.exists()
        with sqlite3.connect(f'file:{db}?mode=ro',uri=True) as connection:assert connection.execute('PRAGMA quick_check').fetchone()[0]=='ok'
        print('PASS',name,'独立会话库检查通过')

if __name__=='__main__':
    for case in ['below','prepared','race','failure','direct','prepared-task']:run_case(case)
