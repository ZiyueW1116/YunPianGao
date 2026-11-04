"""检查待公开文件与 npm 归档的边界；输出只包含位置，不打印疑似敏感值。"""
import argparse,json,re,subprocess,tarfile
from pathlib import Path
from urllib.parse import urlsplit

ROOT=Path(__file__).resolve().parents[1]
ROOT_FILES={'README.md','LICENSE','package.json','package-lock.json','tsconfig.json','.gitignore','server.js'}
SOURCE_DIRS={'src','test','docs','scripts','.github'}
SUFFIXES={'.ts','.js','.mjs','.py','.md','.html','.json','.yaml','.yml','.txt'}
SYNTHETIC_VALUES={'synthetic-only','fixture-only','test-only','redacted','[redacted]'}
PRIVATE=[re.compile('/'+'mnt/cpfs/'),re.compile('/'+'Users/'),re.compile('/'+'root/'),
         re.compile(r'ses_[A-Za-z0-9]{20,}')]
ASSIGNMENT=re.compile(r'''(?i)\b(?:api[_-]?key|access[_-]?token|password|secret)\b["']?\s*[:=]\s*["']([^"'\s]+)''')
EMAIL=re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')

def inspect(name,data,package=False):
    errors=[];path=Path(name)
    if path.is_absolute() or '..' in path.parts:return [(name,0,'归档路径越界')]
    allowed=path.name in ROOT_FILES if len(path.parts)==1 else path.parts[0] in ({'dist','docs','scripts'} if package else SOURCE_DIRS)
    if not allowed:errors.append((name,0,'文件不在公开范围'))
    if name not in ROOT_FILES and path.suffix not in SUFFIXES:errors.append((name,0,'不允许的文件类型'))
    # 官方宿主依赖使生成的锁文件超过 512 KiB；其他公开文件仍保留原上限。
    if len(data)>(1024*1024 if name=='package-lock.json' else 512*1024):errors.append((name,0,'文件超过公开包大小边界'))
    try:text=data.decode('utf-8')
    except UnicodeDecodeError:return errors+[(name,0,'不允许二进制文件')]
    if '\0' in text:errors.append((name,0,'不允许二进制内容'))
    for number,line in enumerate(text.splitlines(),1):
        if any(p.search(line) for p in PRIVATE):errors.append((name,number,'私有路径、入口或真实会话标识'))
        for match in ASSIGNMENT.finditer(line):
            # 公共 npm 包名含凭证关键词；仅豁免精确名称及固定版本的完整依赖行。
            dependency_name='@deepseek-ai/dsh-llm-deepseek-api-'+'key'
            public_dependency=name=='package-lock.json' and re.fullmatch(r'\s*"'+re.escape(dependency_name)+r'": "0\.2\.2-alpha\.3",?',line)
            if not public_dependency and match[1] not in SYNTHETIC_VALUES:errors.append((name,number,'疑似静态凭证赋值'))
        for email in EMAIL.findall(line):
            # npm 锁文件包含 glob 的公开弃用声明；仅允许这个已核实的上游维护者地址。
            public_metadata=name=='package-lock.json' and '"deprecated":' in line and email=='i'+'@izs.me'
            if not public_metadata and not email.endswith(('@example.com','@users.noreply.github.com')):errors.append((name,number,'未允许的邮箱地址'))
        for url in re.findall(r'https?://[^\s\)\]"\']+',line):
            parsed=urlsplit(url)
            if parsed.username or parsed.password:errors.append((name,number,'URL 携带认证信息'))
    return errors

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--package',type=Path);args=parser.parse_args()
    errors=[];count=0
    if args.package:
        with tarfile.open(args.package) as archive:
            for member in archive.getmembers():
                if member.isdir():continue
                if not member.isfile() or not member.name.startswith('package/'):
                    errors.append((member.name,0,'不允许的归档条目'));continue
                name=member.name[len('package/'):];count+=1
                errors.extend(inspect(name,archive.extractfile(member).read(),package=True))
    else:
        top=subprocess.check_output(['git','rev-parse','--show-toplevel'],cwd=ROOT,text=True).strip()
        if Path(top).resolve()!=ROOT:raise SystemExit('请在独立的 YunPianGao 仓库中运行检查。')
        names=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=ROOT).decode().split('\0')
        for name in sorted(set(filter(None,names))):
            path=ROOT/name;count+=1
            if path.is_symlink():errors.append((name,0,'公开文件不允许符号链接'));continue
            errors.extend(inspect(name,path.read_bytes()))
    print(json.dumps({'files':count,'findings':[{'file':n,'line':line,'rule':rule} for n,line,rule in errors]},ensure_ascii=False,indent=2))
    if errors:raise SystemExit(1)

if __name__=='__main__':main()
