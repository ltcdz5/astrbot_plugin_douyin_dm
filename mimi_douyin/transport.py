from __future__ import annotations
import asyncio
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
from .errors import BrowserError
from .cache import CacheFiles

class BrowserWorker:
    def __init__(self, config):
        self.config=config
        self.process=None
        self.reader=None
        self.pending={}
        self.sequence=0
        self.start_lock=asyncio.Lock()
        self.open_lock=asyncio.Lock()  # 串行化 open：_guard 与 _monitor 会并发调用
        self.cache_registration_error=''

    # 保持所有子进程的强引用。
    # asyncio.subprocess.Process 被垃圾回收时，__del__ 会调用 kill() 发 SIGKILL。
    # 插件重载会丢弃旧的 BrowserWorker 实例，旧 worker 就在没有任何日志的情况下
    # 被静默杀掉（退出码 -9、stderr 全空），表现为"自启动反复失败/Connection lost"。
    _LIVE_PROCESSES = []

    async def start(self):
        async with self.start_lock:
            if (self.process and self.process.returncode is None
                    and self.process.stdin and not self.process.stdin.is_closing()):
                return
            # 上一个进程已退出：先从强引用表里移除，避免无限累积。
            if self.process is not None:
                try:BrowserWorker._LIVE_PROCESSES.remove(self.process)
                except ValueError:pass
                self.process=None
            if not self.config.get("node_binary"):raise BrowserError("未找到 Node.js，请先在接入设置中检查依赖。")
            env=os.environ.copy()
            if self.config.get("playwright_browsers_path"):env["PLAYWRIGHT_BROWSERS_PATH"]=self.config["playwright_browsers_path"]
            self.process=await asyncio.create_subprocess_exec(self.config["node_binary"],
                str(Path(__file__).parent/"browser/worker.mjs"),stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,stderr=open("/root/worker.err","ab"),env=env,
                creationflags=0x08000000 if os.name=="nt" else 0,limit=16*1024*1024)
            BrowserWorker._LIVE_PROCESSES.append(self.process)
            self.reader=asyncio.create_task(self._read())

    async def _read(self):
        try:
            while line:=await self.process.stdout.readline():
                reply=json.loads(line)
                future=self.pending.pop(reply.get('id'),None)
                if future and not future.done():
                    if reply.get('ok'):future.set_result(reply['result'])
                    else:future.set_exception(BrowserError(reply.get('error','浏览器操作失败。')))
        finally:
            # 诊断：记录 worker 为何退出，避免只看到 "Connection lost"。
            try:
                rc=self.process.returncode if self.process else None
                with Path("/root/worker-exit.log").open("a",encoding="utf-8") as fh:
                    fh.write("exit rc=%s\n"%(rc,))
                    try:fh.write(Path("/root/worker.err").read_text("utf-8","ignore")[-3000:]+"\n")
                    except OSError:pass
            except Exception:pass
            for future in self.pending.values():
                if not future.done():future.set_exception(BrowserError('抖音浏览器连接已关闭。'))
            self.pending.clear()

    async def call(self, action, args=None, timeout=30):
        await self.start()
        self.sequence+=1
        request_id=self.sequence
        future=asyncio.get_running_loop().create_future()
        self.pending[request_id]=future
        try:
            self.process.stdin.write((json.dumps({'id':request_id,'action':action,'args':args or {}},ensure_ascii=False)+'\n').encode())
            await self.process.stdin.drain()
        except (OSError,ConnectionError,ValueError) as exc:
            self.pending.pop(request_id,None)
            raise BrowserError('抖音浏览器连接已关闭。') from exc
        try:
            result=await asyncio.wait_for(future,timeout)
            if action in ('download','browse') and self.config.get('media_cache_registry'):
                try:
                    CacheFiles(self.config['media_cache_registry']).register(self.config['media_dir'],result)
                    self.cache_registration_error=''
                except (OSError,sqlite3.Error):self.cache_registration_error='缓存登记暂不可写，未登记的文件会保留。'
            return result
        except asyncio.TimeoutError as exc:
            self.pending.pop(request_id,None)
            if action=='send':return {'state':'unknown','receipt':'browser_command_timeout'}
            raise BrowserError('抖音浏览器操作超时。') from exc

    async def open(self,peer=None):
        # _guard 和 _monitor 两个循环都会调用这里。并发 open 会在同一个 worker 上
        # 同时执行 connectOverCDP + 页面导航，互相打断，表现为 Connection lost。
        async with self.open_lock:
            return await self.call('open',{'profile':self.config['browser_profile'],
                'media_dir':self.config['media_dir'],'playwright_package':self.config['playwright_package'],
                'max_download_mb':self.config.get('max_download_mb',64),
                'max_video_duration_seconds':self.config.get('max_video_duration_seconds',180),
                'max_post_images':self.config.get('max_post_images',30),'restore_peer':peer,
                'browser_channel':self.config.get('browser_channel',''),
                'browser_executable':self.config.get('browser_executable',''),
                'headless':bool(self.config.get('browser_headless',False))},timeout=int(self.config.get('open_timeout_seconds',240)))

    async def close(self):
        if not self.process or self.process.returncode is not None:return
        # 直接写 close 指令，但不经过 self.call()：
        # call() 开头会 await self.start()，进程刚退出时会重新拉起一个 worker，
        # 随后关闭 stdin 让它读到 EOF，worker 就静默 exit(0)，
        # 表现为日志里 worker 反复启动又消失、stderr 全空。
        try:
            payload=json.dumps({"id":0,"action":"close","args":{}},ensure_ascii=False)+"\n"
            self.process.stdin.write(payload.encode())
            await self.process.stdin.drain()
        except (OSError,ConnectionError,ValueError):
            pass
        try:
            if self.process.stdin:self.process.stdin.close()
        except (OSError,ConnectionError):
            pass
        try:
            await asyncio.wait_for(self.process.wait(),8)
        except asyncio.TimeoutError:
            try:self.process.terminate()
            except OSError:pass
            try:await asyncio.wait_for(self.process.wait(),3)
            except asyncio.TimeoutError:
                try:self.process.kill()
                except OSError:pass
                await self.process.wait()
        if self.reader:await asyncio.gather(self.reader,return_exceptions=True)


class Ledger:
    def __init__(self,path):
        self.db=sqlite3.connect(path)
        self.db.execute('CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, details TEXT NOT NULL, updated REAL NOT NULL)')
        self.db.execute("UPDATE jobs SET state='interrupted' WHERE state IN ('queued','generating')")
        self.db.execute("UPDATE jobs SET state='unknown' WHERE state='sending'")
        self.db.commit()

    def get(self,key,default=None):
        row=self.db.execute('SELECT value FROM state WHERE key=?',(key,)).fetchone()
        return json.loads(row[0]) if row else default

    def put(self,key,value):
        self.db.execute('INSERT OR REPLACE INTO state VALUES (?,?)',(key,json.dumps(value,ensure_ascii=False)))
        self.db.commit()

    def observe(self,peer_key,items,*,prime=False):
        key='snapshot:'+peer_key
        current=[{k:item.get(k) for k in ('fingerprint','native_id','sender')} for item in items]
        previous=self.get(key)
        self.put(key,current)
        if prime or previous is None:return []
        def identity(item):return (item.get('native_id') or item['fingerprint'],item['sender'])
        old=[identity(x) for x in previous];new=[identity(x) for x in current]
        overlap=0
        for length in range(min(len(old),len(new)),0,-1):
            if old[-length:]==new[:length]:overlap=length;break
        # Without an overlap we cannot distinguish old history, a virtual-list
        # reset, and new messages; re-baseline instead of replaying history.
        if not overlap:return []
        return [x for x in items[overlap:] if x['sender']=='peer']

    def job(self,job_id,state,details=None):
        if details is None:
            row=self.db.execute('SELECT details FROM jobs WHERE id=?',(job_id,)).fetchone()
            details=json.loads(row[0]) if row else {}
        self.db.execute('INSERT OR REPLACE INTO jobs VALUES (?,?,?,?)',
            (job_id,state,json.dumps(details,ensure_ascii=False),time.time()))
        self.db.commit()

    def outbox(self,job_id,text):
        digest=hashlib.sha256(text.encode()).hexdigest()
        key='outbox:'+job_id+':'+digest
        if self.get(key) is not None:return None
        self.put(key,{'state':'sending','at':time.time()})
        self.job(job_id,'sending')
        return key

    def close(self):self.db.close()


