#!/usr/bin/env python3
import base64
import concurrent.futures
import datetime
import http.cookiejar
import json
import os
from pathlib import Path
import socket
import signal
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PHP = os.environ.get('PODSYNC_PHP', 'php')

class SyncAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='podsync-test-')
        folder = Path(cls.temp.name)
        config = folder / 'config.php'
        dsn=os.environ.get('PODSYNC_TEST_DSN','sqlite:'+str(folder/'test.db'))
        config.write_text("<?php return " + "['dsn'=>'" + dsn + "','db_user'=>'root','session_path'=>'" + str(folder / 'sessions') + "'];")
        cls.env = dict(os.environ, PODSYNC_CONFIG=str(config), PHP_CLI_SERVER_WORKERS='4')
        subprocess.run([PHP, str(ROOT / 'bin/manage.php'), 'install'], env=cls.env, check=True, capture_output=True)
        for name in ('alice', 'bob'):
            subprocess.run([PHP, str(ROOT / 'bin/manage.php'), 'add-user', name], input=b'test-only-password-123\n', env=cls.env, check=True, capture_output=True)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        cls.base = f'http://127.0.0.1:{port}'
        cls.log = open(folder / 'server.log', 'wb')
        cls.proc = subprocess.Popen([PHP, '-S', f'127.0.0.1:{port}', '-t', str(ROOT / 'public'), str(ROOT / 'public/router.php')], env=cls.env, stdout=cls.log, stderr=cls.log, start_new_session=True)
        for _ in range(100):
            try:
                urllib.request.urlopen(cls.base + '/health', timeout=1).read()
                break
            except (OSError, urllib.error.URLError):
                time.sleep(.05)
        else:
            raise RuntimeError('Server failed to start')

    @classmethod
    def tearDownClass(cls):
        os.killpg(cls.proc.pid, signal.SIGTERM); cls.proc.wait(timeout=5); cls.log.close(); cls.temp.cleanup()

    def client(self, name='alice'):
        opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        auth=base64.b64encode((name+':test-only-password-123').encode()).decode()
        self.request(opener,f'/api/2/auth/{name}/login.json',{},headers={'Authorization':'Basic '+auth})
        return opener

    def request(self, opener, path, data=None, status=200, headers=None):
        headers=dict(headers or {})
        if data is not None:
            data=json.dumps(data).encode(); headers['Content-Type']='application/json'
        request=urllib.request.Request(self.base+path,data=data,headers=headers)
        try:
            response=opener.open(request,timeout=20)
        except urllib.error.HTTPError as e:
            response=e
        self.assertEqual(response.code,status, response.read().decode() if response.code!=status else '')
        with response:
            return json.load(response)

    @staticmethod
    def item(name):
        return {'podcast':'https://example.test/feed','episode':f'https://example.test/{name}.mp3','guid':name,'title':name,'podcast_title':'Test podcast','published':1700000000,'duration':123}

    def queue(self,opener,device,base,letters):
        return self.request(opener,f'/api/2/queue/alice/{device}.json',{'base_revision':base,'items':[self.item(x) for x in letters]})

    def test_01_auth_devices_subscriptions(self):
        anon=urllib.request.build_opener()
        self.request(anon,'/api/2/devices/alice.json',status=401)
        alice=self.client(); bob=self.client('bob')
        self.request(alice,'/api/2/devices/alice/desktop.json',{'caption':'Desktop','type':'desktop'})
        self.request(alice,'/api/2/devices/alice/phone.json',{'caption':'Phone','type':'mobile'})
        self.assertEqual(len(self.request(alice,'/api/2/devices/alice.json')),2)
        self.request(alice,'/api/2/subscriptions/alice/desktop.json',{'add':['https://example.test/feed'],'remove':[]})
        self.assertEqual(self.request(alice,'/api/2/subscriptions/alice/phone.json?since=0')['add'],['https://example.test/feed'])
        self.assertEqual(self.request(bob,'/api/2/subscriptions/bob/phone.json?since=0')['add'],[])
        self.request(bob,'/api/2/devices/alice.json',status=401)
        self.assertEqual(self.request(alice,'/api/2/sync-devices/alice.json')['synchronized'],[['desktop','phone']])
        self.request(alice,'/api/2/subscriptions/alice/phone.json',{'add':[],'remove':['https://example.test/feed']})
        self.assertEqual(self.request(alice,'/api/2/subscriptions/alice/desktop.json?since=0')['remove'],['https://example.test/feed'])
        self.request(alice,'/api/2/subscriptions/alice/desktop.json',{'add':['file:///etc/passwd']},status=400)
        self.request(alice,'/api/2/auth/alice/logout.json',{})
        self.request(alice,'/api/2/devices/alice.json',status=401)

    def test_02_queue_three_way_merge(self):
        a=self.client(); b=self.client()
        one=self.queue(a,'desktop',None,['A','B'])
        two=self.queue(b,'phone',None,['C'])
        self.assertEqual([i['guid'] for i in two['items']],['A','B','C'])
        three=self.queue(a,'desktop',one['revision'],['B','A','D'])
        self.assertEqual([i['guid'] for i in three['items']],['B','A','D','C'])
        four=self.queue(b,'phone',two['revision'],['A','C'])
        self.assertEqual([i['guid'] for i in four['items']],['A','D','C'])
        same=self.queue(a,'desktop',three['revision'],['B','A','D','C'])
        self.assertEqual([i['guid'] for i in same['items']],['A','D','C'])
        self.assertEqual(same['revision'],four['revision'])
        five=self.queue(a,'desktop',same['revision'],['C','A','D'])
        self.assertEqual([i['guid'] for i in five['items']],['C','A','D'])
        initial=self.queue(b,'newphone',None,[])
        self.assertEqual(initial['items'],five['items'])
        cleared=self.queue(a,'desktop',five['revision'],[])
        self.assertEqual(cleared['items'],[])
        self.request(a,'/api/2/queue/alice/desktop.json',{'base_revision':9999999,'items':[]},status=409)
        self.request(self.client('bob'),'/api/2/queue/alice/phone.json',status=401)
        before=self.request(a,'/api/2/queue/alice/desktop.json')
        self.request(a,'/api/2/queue/alice/desktop.json',{'items':[{'podcast':'','episode':'https://example.test/bad'}]},status=400)
        self.assertEqual(self.request(a,'/api/2/queue/alice/desktop.json'),before)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
            results=list(ex.map(lambda x:self.queue(self.client(),x,cleared['revision'],[x]),['X','Y']))
        end=self.request(a,'/api/2/queue/alice/desktop.json')
        self.assertEqual({x['guid'] for x in end['items']},{'X','Y'})

        base=self.queue(a,'desktop',end['revision'],['A','B'])
        inserted=self.queue(a,'desktop',base['revision'],['A','C','B'])
        self.assertEqual([x['guid'] for x in inserted['items']],['A','C','B'])
        front=self.queue(a,'desktop',inserted['revision'],['D','A','C','B'])
        self.assertEqual([x['guid'] for x in front['items']],['D','A','C','B'])
        stale=self.queue(b,'phone',inserted['revision'],['A','E','C','B'])
        self.assertEqual([x['guid'] for x in stale['items']],['D','A','E','C','B'])
        no_guid=self.item('NO_GUID'); no_guid['guid']=''
        one=self.request(a,'/api/2/queue/alice/desktop.json',{'base_revision':stale['revision'],'items':[no_guid]})
        fallback=dict(no_guid,guid=no_guid['episode'])
        two=self.request(b,'/api/2/queue/alice/phone.json',{'base_revision':None,'items':[fallback]})
        self.assertEqual(len(two['items']),1)

    def test_03_full_push_10661_actions_and_cursor_overlap(self):
        a=self.client()
        stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')
        actions=[{'podcast':'https://example.test/feed','episode':f'https://example.test/{i}.mp3','guid':str(i),'device':'desktop','action':'play','timestamp':stamp,'started':i%100,'position':i%100,'total':123} for i in range(10661)]
        for start in range(0,len(actions),30):
            last=self.request(a,'/api/2/episodes/alice.json',actions[start:start+30])
        result=self.request(a,'/api/2/episodes/alice.json?since=0')
        self.assertEqual(len(result['actions']),10661)
        self.assertEqual(len({x['episode'] for x in result['actions']}),10661)
        self.request(a,'/api/2/episodes/alice.json',actions[:30])
        self.assertEqual(len(self.request(a,'/api/2/episodes/alice.json?since=0')['actions']),10661)
        bad=dict(actions[0],podcast='')
        self.request(a,'/api/2/episodes/alice.json',[bad],status=400)
        fresh=dict(actions[0],episode='https://example.test/fresh.mp3')
        cursor=self.request(a,'/api/2/episodes/alice.json',[fresh])['timestamp']
        delta=self.request(a,f'/api/2/episodes/alice.json?since={cursor+1}')
        self.assertTrue(any(x['episode']==fresh['episode'] for x in delta['actions']))
        self.assertEqual(self.request(self.client('bob'),'/api/2/episodes/bob.json?since=0')['actions'],[])

if __name__=='__main__': unittest.main(verbosity=2)
