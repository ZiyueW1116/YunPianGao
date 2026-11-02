"""通过真实 OpenCode 2.1.4 验证任务等待；所有请求与会话仅使用本地合成数据。"""
import base64,http.server,json,os,re,shutil,socket,sqlite3,subprocess,tempfile,threading,time,urllib.request
from pathlib import Path
from runtime import ROOT, SUMMARY, wait


def run_case(name):
    with tempfile.TemporaryDirectory(prefix='yunpiangao-wait-') as td:
        root=Path(td).resolve();workspace=root/'workspace';workspace.mkdir()
        for folder in ['config','data','state','cache']:(root/folder).mkdir()
        calls=[];release=threading.Event();waiting=threading.Event();resumed=threading.Event()
        resumed_at=[];completed_at=[];primary=0;sid=None
        def events():
            path=root/'events.jsonl'
            result=[]
            if path.exists():
                for line in path.read_text().splitlines():
                    try:result.append(json.loads(line))
                    except ValueError:pass
            return result
        class Provider(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                nonlocal primary
                body=json.loads(self.rfile.read(int(self.headers['content-length'])))
                kind=self.headers.get('x-yunpiangao-test-kind','primary')
                history=json.dumps(body.get('messages',[]),ensure_ascii=False)
                child=self.headers.get('x-yunpiangao-test-session')!=sid
                calls.append({'kind':kind,'child':child,'at':time.monotonic()})
                tool=None;text='合成任务已接续。'
                if kind=='compaction':text=SUMMARY
                elif child:
                    child_calls=sum(c['kind']=='primary' and c['child'] for c in calls)
                    if name=='child-nested-wait' and child_calls==1:
                        code='from pathlib import Path; import time; p=Path("release");\nwhile not p.exists(): time.sleep(.02)\nprint("NESTED_PROCESS_DONE")'
                        tool=('start_process',{'command':shutil.which('python3'),'args':['-c',code]})
                    elif name=='child-nested-wait' and child_calls==2:
                        handle=re.search(r'ypg_[0-9a-f-]{36}',history)
                        tool=('wait_for',{'handle':handle[0],'timeout':10})
                    elif name=='child-compact' and child_calls==1:tool=('shell',{'command':'printf SYNTHETIC_CHILD_STAGE_ONE'})
                    elif name=='child-websearch' and child_calls==1:tool=('websearch',{'query':'synthetic form test'})
                    elif name=='child-permission' and child_calls==1:tool=('shell',{'command':'printf SYNTHETIC_CHILD_DONE'})
                    elif name=='child-question' and child_calls==1:tool=('question',{'questions':[{'question':'合成任务是否继续？','header':'合成确认','options':[{'label':'继续','description':'继续合成任务'}]}]})
                    else:release.wait(15);completed_at.append(time.monotonic());text='SYNTHETIC_CHILD_DONE'
                elif kind=='primary':
                    primary+=1
                    if primary==1:
                        if name.startswith('child'):
                            tool=('start_subagent',{'agent':'general','description':'合成子任务','prompt':'SYNTHETIC_CHILD：返回完成标记。'})
                        else:
                            code='from pathlib import Path; import time; p=Path("release");\nwhile not p.exists(): time.sleep(.02)\nprint("SYNTHETIC_PROCESS_DONE"); Path("completed").touch()'
                            if name=='process-before':code='print("SYNTHETIC_PROCESS_DONE")'
                            if name=='process-failure':code='raise SystemExit(7)'
                            tool=('start_process',{'command':shutil.which('python3'),'args':['-c',code]})
                    elif primary==2 or (name=='process-timeout' and primary==3) or (name.endswith('cancel') and primary==4):
                        handle=re.search(r'ypg_[0-9a-f-]{36}',history)
                        assert handle,history
                        tool=('wait_for',{'handle':handle[0],'timeout':.15 if name=='process-timeout' and primary==2 else 10});waiting.set()
                    elif name.endswith('cancel') and primary==3:
                        handle=re.search(r'ypg_[0-9a-f-]{36}',history)
                        tool=('cancel_task',{'handle':handle[0]})
                    else:
                        assert '云片糕任务运行时状态' in history
                        resumed_at.append(time.time()*1000);resumed.set()
                delta={'role':'assistant','content':text}
                if tool:delta={'role':'assistant','tool_calls':[{'index':0,'id':f'call_{primary}','type':'function','function':{'name':tool[0],'arguments':json.dumps(tool[1])}}]}
                self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
                data={'id':'synthetic','model':body['model'],'created':0}
                for finish,part in [(None,delta),('tool_calls' if tool else 'stop',{})]:
                    try:self.wfile.write(('data: '+json.dumps({**data,'choices':[{'index':0,'delta':part,'finish_reason':finish}]})+'\n\n').encode())
                    except (BrokenPipeError,ConnectionResetError):return
                tokens=590000 if name=='child-compact' and child and kind=='primary' and child_calls==1 else 1000
                try:self.wfile.write(('data: '+json.dumps({**data,'choices':[],'usage':{'prompt_tokens':tokens,'completion_tokens':10,'total_tokens':tokens+10}})+'\n\ndata: [DONE]\n\n').encode())
                except (BrokenPipeError,ConnectionResetError):pass
        provider=http.server.ThreadingHTTPServer(('127.0.0.1',0),Provider)
        thread=threading.Thread(target=provider.serve_forever,daemon=True);thread.start()
        config={'plugins':[{'package':str(ROOT/'test/observer'),'options':{'events':str(root/'events.jsonl')}},{'package':str(ROOT)}],
                'providers':{'synthetic':{'name':'本地合成替身','package':'@opencode/ai/providers/openai-compatible',
                'settings':{'baseURL':f'http://127.0.0.1:{provider.server_port}/v1','apiKey':'synthetic-only'},
                'models':{'synthetic':{'limit':{'context':600000,'output':384000}}}}}}
        if name=='child-compact':
            config['compaction']={'auto':True,'keep':{'tokens':0},'buffer':60000}
            config['experimental']={'background_compaction':False}
        (root/'config/opencode.json').write_text(json.dumps(config))
        env=dict(os.environ,OPENCODE_CONFIG_DIR=str(root/'config'),XDG_CONFIG_HOME=str(root/'config'),XDG_DATA_HOME=str(root/'data'),XDG_STATE_HOME=str(root/'state'),XDG_CACHE_HOME=str(root/'cache'),OPENCODE_DISABLE_MODELS_FETCH='true',NO_COLOR='1')
        with socket.socket() as reserve:reserve.bind(('127.0.0.1',0));port=reserve.getsockname()[1]
        log=(root/'server.log').open('wb');proc=None
        try:
            executable=os.environ.get('OPENCODE_BIN') or shutil.which('opencode')
            if not executable:raise RuntimeError('请通过 OPENCODE_BIN 指定 OpenCode 2.1.4。')
            proc=subprocess.Popen([executable,'serve','--hostname','127.0.0.1','--port',str(port)],cwd=workspace,env=env,stdout=log,stderr=subprocess.STDOUT)
            found=wait(lambda:re.search(r'server password (\S+)',(root/'server.log').read_text(errors='replace')))
            auth=base64.b64encode(('opencode:'+found[1]).encode()).decode()
            def api(method,path,body=None):
                req=urllib.request.Request(f'http://127.0.0.1:{port}'+path,data=json.dumps(body).encode() if body is not None else None,method=method,headers={'Authorization':'Basic '+auth,'Content-Type':'application/json'})
                with urllib.request.urlopen(req,timeout=10) as response:
                    data=response.read()
                    return json.loads(data) if data else None
            permissions=[{'action':'*','resource':'*','effect':'allow'}]
            if name=='child-permission':permissions.append({'action':'shell','resource':'*','effect':'ask'})
            session=api('POST','/api/session',{'title':'合成任务等待','location':{'directory':str(workspace)},'model':{'providerID':'synthetic','id':'synthetic'},'permissions':permissions})['data']
            sid=session['id'];api('POST',f'/api/session/{sid}/prompt',{'text':'合成任务：启动任务并使用 wait_for。'})
            wait(waiting.is_set)
            wait(lambda:any(e['type']=='session.execution.interrupted' and e['sessionID']==sid for e in events()))
            early=name in ['process-before','process-failure','child-permission','child-question','child-websearch']
            if not early and name!='process-timeout':time.sleep(.2);assert primary==2,primary
            if name.endswith('input'):
                api('POST',f'/api/session/{sid}/prompt',{'text':'用户介入：先处理这条输入，结束本次等待。'})
                wait(resumed.is_set);assert primary==3
                launched=next(e for e in events() if e['type']=='session.tool.success' and e['sessionID']==sid and e['id']=='call_1')
                handle=json.loads(launched['content'][0]['text'])['handle']
                if handle['kind']=='process':os.kill(int(handle['executionID'].rsplit(':',1)[1]),0)
                else:assert api('GET',f'/api/session/{handle["executionID"]}')['data'].get('outcome') is None
            elif name=='child-nested-wait':
                wait(lambda:any(e['type']=='session.tool.input.started' and e['sessionID']!=sid and e.get('name')=='wait_for' for e in events()))
                wait(lambda:any(e['type']=='session.execution.interrupted' and e['sessionID']!=sid for e in events()))
                time.sleep(.2);assert primary==2,primary
            elif name=='child-compact':
                wait(lambda:any(e['type']=='session.compaction.ended' and e['sessionID']!=sid for e in events()))
                assert primary==2
            elif name.endswith('compact'):
                api('POST',f'/api/session/{sid}/compact',{})
                wait(lambda:any(e['type']=='session.compaction.ended' for e in events()))
                assert primary==2
            elif name.endswith('cancel'):
                api('POST',f'/api/session/{sid}/prompt',{'text':'用户介入：取消该任务，并等待取消结果。'})
                wait(resumed.is_set)
            elif name=='process-timeout':
                wait(lambda:sum(e['type']=='session.execution.interrupted' and e['sessionID']==sid for e in events())==2)
                assert primary==3
            elif name=='process-deleted':
                api('DELETE',f'/api/session/{sid}')
                wait(lambda:any(e['type']=='session.deleted' and e['sessionID']==sid for e in events()))
            elif name=='child-websearch':
                wait(resumed.is_set)
                form=next(e['form'] for e in events() if e['type']=='form.created' and e['form'].get('metadata',{}).get('kind')=='websearch.provider')
                api('DELETE',f'/api/session/{form["sessionID"]}/form/{form["id"]}')
                wait(lambda:any(e['type']=='form.cancelled' and e['id']==form['id'] for e in events()))
            release.set();(workspace/'release').touch();completed_at.append(time.monotonic())
            if name=='process-deleted':
                wait(lambda:(workspace/'completed').exists())
                time.sleep(1.3)
                assert primary==2,primary
                warnings=(root/'server.log').read_text(errors='replace').count('任务状态或接续请求暂未完成')
                assert warnings==0,warnings
                print('PASS',name,json.dumps({'primary_calls':primary,'resume_retry_warnings':warnings,'background_process_completed':True}))
            else:
                if not name.endswith('input'):wait(resumed.is_set)
                expected=4 if name=='process-timeout' else 5 if name.endswith('cancel') else 3
                time.sleep(.6);assert primary==expected,primary
                data=api('GET',f'/api/experimental/session/{sid}/export?sanitize=false')['data']
                notifications=[m for m in data['messages'] if m['type']=='synthetic' and m.get('metadata',{}).get('source')=='yunpiangao.wait']
                assert len(notifications)==(0 if name.endswith('input') else 2 if name=='process-timeout' else 1),notifications
                results=[json.loads(m['text'].split('\n',1)[1]) for m in notifications]
                reasons=[result['reason'] for result in results]
                expected_reasons=[] if name.endswith('input') else ['timeout','succeeded'] if name=='process-timeout' else ['failed'] if name=='process-failure' else ['cancelled'] if name.endswith('cancel') else ['input_required'] if name in ['child-permission','child-question','child-websearch'] else ['succeeded']
                assert reasons==expected_reasons,reasons
                if name in ['child-compact','child-nested-wait','child-websearch']:
                    launched=next(e for e in events() if e['type']=='session.tool.success' and e['sessionID']==sid and e['id']=='call_1')
                    child_id=json.loads(launched['content'][0]['text'])['handle']['executionID']
                    wait(lambda:api('GET',f'/api/session/{child_id}')['data'].get('outcome')=='succeeded')
                if name=='process-duplicate':
                    notification=notifications[0]
                    for _ in range(2):api('POST',f'/api/session/{sid}/synthetic',{'id':notification['id'],'text':notification['text'],'metadata':notification['metadata'],'description':notification['description']})
                    time.sleep(.3);assert primary==expected
                long_sleeps=sum(bool(re.search(r'\bsleep\s+(?:[6-9]\d|\d{3,})\b',json.dumps(e.get('input',{})))) for e in events() if e['type']=='session.tool.called')
                print('PASS',name,json.dumps({'primary_calls':primary,'unnecessary_wakeups':primary-expected,'long_sleep_calls':long_sleeps,'primary_tokens':primary*1010,'resume_latency_ms':round(resumed_at[-1]-results[-1]['snapshot']['finishedAt']) if results and results[-1]['snapshot'].get('finishedAt') else None},ensure_ascii=False))
        except BaseException:
            print('合成等待诊断',json.dumps({'case':name,'calls':calls,'events':events()},ensure_ascii=False)[-18000:])
            print('\n'.join(re.sub(r'server password \S+','server password [redacted]',line) for line in (root/'server.log').read_text(errors='replace').splitlines())[-8000:])
            raise
        finally:
            release.set();(workspace/'release').touch()
            if proc:
                proc.terminate()
                try:proc.wait(10)
                except subprocess.TimeoutExpired:proc.kill();proc.wait()
            log.close();provider.shutdown();provider.server_close();thread.join()
        with sqlite3.connect(f'file:{root/"data/opencode/opencode.db"}?mode=ro',uri=True) as connection:assert connection.execute('PRAGMA quick_check').fetchone()[0]=='ok'


if __name__=='__main__':
    for case in ['process','process-before','process-failure','process-timeout','process-input','process-cancel','process-compact','process-duplicate','child','child-input','child-cancel','child-permission','child-question','child-nested-wait','child-compact','process-deleted','child-websearch']:run_case(case)
