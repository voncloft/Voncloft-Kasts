<?php
declare(strict_types=1);
namespace PodcastSync;
use PDO;
use RuntimeException;
use Throwable;

final class HttpError extends RuntimeException {
    public function __construct(public int $status, string $message) { parent::__construct($message); }
}

final class Server {
    private PDO $db;
    private string $driver;
    private array $config;
    public function __construct(array $config) {
        $this->config = $config;
        $this->db = new PDO($config['dsn'], $config['db_user'] ?? null, $config['db_password'] ?? null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
        $this->driver = $this->db->getAttribute(PDO::ATTR_DRIVER_NAME);
        if (!in_array($this->driver, ['mysql', 'sqlite'], true)) { throw new RuntimeException('Unsupported database.'); }
        if ($this->driver === 'sqlite') {
            $this->db->exec('PRAGMA foreign_keys=ON');
            $this->db->exec('PRAGMA busy_timeout=10000');
        }
    }
    public function database(): PDO { return $this->db; }
    public function install(): void {
        $this->db->exec(file_get_contents(dirname(__DIR__) . '/sql/' . $this->driver . '.sql'));
        if (!is_dir($this->config['session_path'])) { mkdir($this->config['session_path'], 0700, true); }
    }
    public function addUser(string $name, string $password): void {
        self::identifier($name, 64);
        if (strlen($password) < 12) { throw new RuntimeException('Use at least 12 characters for the password.'); }
        $q = $this->db->prepare('INSERT INTO ps_users(username,password_hash,queue_json) VALUES(?,?,?)');
        $q->execute([$name, password_hash($password, PASSWORD_DEFAULT), '[]']);
    }
    public static function identifier(string $value, int $limit = 128): string {
        if (!preg_match('/^[a-zA-Z0-9_.-]{1,' . $limit . '}$/D', $value)) { throw new HttpError(400, 'Invalid user or device identifier.'); }
        return $value;
    }
    private static function url(mixed $value): string {
        if (!is_string($value) || strlen($value) > 8192 || preg_match('/[\x00-\x20]/', $value)
            || !in_array(strtolower((string)parse_url($value, PHP_URL_SCHEME)), ['http', 'https'], true)
            || !parse_url($value, PHP_URL_HOST)) { throw new HttpError(400, 'Expected an HTTP(S) URL.'); }
        return $value;
    }
    private function query(string $sql, array $args = []): \PDOStatement {
        $q = $this->db->prepare($sql); $q->execute($args); return $q;
    }
    private function transaction(int $uid, callable $callback): mixed {
        $this->db->beginTransaction();
        try {
            $this->query('UPDATE ps_users SET queue_revision=queue_revision WHERE id=?', [$uid]);
            $result = $callback();
            $this->db->commit();
            return $result;
        } catch (Throwable $e) { $this->db->rollBack(); throw $e; }
    }
    private function jsonBody(): mixed {
        $max = $this->config['max_body_bytes'] ?? 16777216;
        if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > $max) { throw new HttpError(413, 'Request too large.'); }
        $raw = file_get_contents('php://input', false, null, 0, $max + 1);
        if (strlen($raw) > $max) { throw new HttpError(413, 'Request too large.'); }
        if ($raw === '') { return []; }
        try { return json_decode($raw, true, 64, JSON_THROW_ON_ERROR); }
        catch (\JsonException) { throw new HttpError(400, 'Invalid JSON.'); }
    }
    private function session(): void {
        if (session_status() === PHP_SESSION_ACTIVE) { return; }
        session_name('podsync_session');
        session_save_path($this->config['session_path']);
        ini_set('session.use_strict_mode', '1');
        session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off', 'httponly' => true, 'samesite' => 'Lax']);
        if (!session_start()) { throw new RuntimeException('Cannot start session.'); }
    }
    private function authenticate(string $name, bool $login = false): array {
        self::identifier($name, 64);
        $user = $this->query('SELECT * FROM ps_users WHERE username=?', [$name])->fetch();
        $basicUser = $_SERVER['PHP_AUTH_USER'] ?? null;
        $basicPass = $_SERVER['PHP_AUTH_PW'] ?? null;
        $authorization = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
        if ($basicUser === null && preg_match('/^Basic\s+(.*)$/i', $authorization, $m)) {
            $decoded = base64_decode($m[1], true);
            if ($decoded !== false && str_contains($decoded, ':')) { [$basicUser, $basicPass] = explode(':', $decoded, 2); }
        }
        $this->session();
        if ($basicUser !== null) {
            $ok = $user && hash_equals($name, (string)$basicUser) && password_verify((string)$basicPass, $user['password_hash']);
        } else {
            $ok = $user && !$login && (int)($_SESSION['uid'] ?? 0) === (int)$user['id'];
        }
        if (!$ok) {
            session_write_close();
            header('WWW-Authenticate: Basic realm="Podcast Sync", charset="UTF-8"');
            throw new HttpError(401, 'Authentication required.');
        }
        if ($login) { session_regenerate_id(true); $_SESSION['uid'] = (int)$user['id']; }
        session_write_close();
        return $user;
    }
    private static function output(mixed $data, int $status = 200): never {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        header('X-Content-Type-Options: nosniff');
        echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        exit;
    }
    private function device(int $uid, string $id, array $body = []): void {
        self::identifier($id);
        $old = $this->query('SELECT * FROM ps_devices WHERE user_id=? AND device_id=?', [$uid, $id])->fetch();
        $caption = $body['caption'] ?? ($old['caption'] ?? $id);
        $type = $body['type'] ?? ($old['device_type'] ?? 'other');
        if (!is_string($caption) || strlen($caption) > 255 || !in_array($type, ['desktop','laptop','mobile','server','other'], true)) {
            throw new HttpError(400, 'Invalid device description.');
        }
        if ($old) { $this->query('UPDATE ps_devices SET caption=?, device_type=? WHERE user_id=? AND device_id=?', [$caption,$type,$uid,$id]); }
        else { $this->query('INSERT INTO ps_devices(user_id,device_id,caption,device_type) VALUES(?,?,?,?)', [$uid,$id,$caption,$type]); }
    }
    public static function queueKey(array $item): string {
        return hash('sha256', $item['podcast'] . "\n" . ($item['guid'] !== '' ? $item['guid'] : $item['episode']));
    }
    public static function normalizeQueue(mixed $items): array {
        if (!is_array($items) || !array_is_list($items) || count($items) > 50000) { throw new HttpError(400, 'Invalid queue.'); }
        $out = []; $seen = [];
        foreach ($items as $item) {
            if (!is_array($item)) { throw new HttpError(400, 'Invalid queue item.'); }
            $clean = ['podcast' => self::url($item['podcast'] ?? null), 'episode' => self::url($item['episode'] ?? null)];
            foreach (['guid' => 8192, 'title' => 2048, 'podcast_title' => 2048] as $field => $limit) {
                $value = $item[$field] ?? '';
                if (!is_string($value) || strlen($value) > $limit) { throw new HttpError(400, 'Invalid queue metadata.'); }
                $clean[$field] = $value;
            }
            foreach (['published', 'duration'] as $field) {
                $value = $item[$field] ?? 0;
                if (!is_int($value) || $value < 0 || $value > 2147483647) { throw new HttpError(400, 'Invalid queue metadata.'); }
                $clean[$field] = $value;
            }
            $key = self::queueKey($clean);
            if (!isset($seen[$key])) { $out[] = $clean; $seen[$key] = true; }
        }
        return $out;
    }
    public static function mergeQueue(?array $base, array $local, array $remote): array {
        $map = static function(array $items): array {
            $out=[]; foreach ($items as $item) { $out[self::queueKey($item)] = $item; } return $out;
        };
        $l=$map($local); $r=$map($remote);
        if ($base === null) { return array_values($r + $l); }
        $b=$map($base);
        if (array_keys($b) === array_keys($r)) { return array_values($l); }
        $removed = array_diff_key($b, $l);
        $selected = array_diff_key($r, $removed) + array_diff_key($l, $b);
        $before = array_keys(array_intersect_key($b, $l));
        $after = array_keys(array_intersect_key($l, $b));
        if ($before !== $after) {
            return array_values(array_intersect_key($l, $selected) + $selected);
        }
        $order=array_keys(array_intersect_key($r,$selected));
        $previous=null;
        foreach ($l as $key=>$item) {
            if (!isset($selected[$key])) { continue; }
            if (!in_array($key,$order,true)) {
                $at=$previous===null ? 0 : array_search($previous,$order,true)+1;
                array_splice($order,$at,0,[$key]);
            }
            $previous=$key;
        }
        return array_map(static fn($key)=>$selected[$key],$order);
    }
    private function syncQueue(int $uid, string $device, array $body): array {
        $local = self::normalizeQueue($body['items'] ?? null);
        $revision = $body['base_revision'] ?? null;
        if ($revision !== null && (!is_int($revision) || $revision < 0)) { throw new HttpError(400, 'Invalid queue revision.'); }
        return $this->transaction($uid, function() use($uid,$device,$local,$revision) {
            $this->device($uid,$device);
            $user=$this->query('SELECT queue_revision,queue_json FROM ps_users WHERE id=?',[$uid])->fetch();
            $current=(int)$user['queue_revision'];
            if ($revision !== null && $revision > $current) { throw new HttpError(409, 'Queue revision is newer than this server. Reconnect to the correct server.'); }
            $remote=json_decode($user['queue_json'],true,64,JSON_THROW_ON_ERROR);
            if ($revision === null) { $base=null; }
            elseif ($revision === $current) { $base=$remote; }
            elseif ($revision === 0) { $base=[]; }
            else {
                $row=$this->query('SELECT queue_json FROM ps_queue_history WHERE user_id=? AND revision=?',[$uid,$revision])->fetch();
                if (!$row) { throw new HttpError(409,'Queue baseline is unavailable.'); }
                $base=json_decode($row['queue_json'],true,64,JSON_THROW_ON_ERROR);
            }
            $merged=self::mergeQueue($base,$local,$remote);
            $json=json_encode($merged,JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR);
            if ($json !== $user['queue_json']) {
                ++$current;
                $this->query('UPDATE ps_users SET queue_revision=?, queue_json=? WHERE id=?',[$current,$json,$uid]);
                $this->query('INSERT INTO ps_queue_history(user_id,revision,queue_json,changed_at) VALUES(?,?,?,?)',[$uid,$current,$json,time()]);
            }
            return ['protocol'=>'vonqueue-v1','revision'=>$current,'items'=>$merged];
        });
    }
    private function subscriptions(int $uid, string $device, string $method): never {
        self::identifier($device);
        if ($method === 'POST') {
            $body=$this->jsonBody();
            if (!is_array($body)) { throw new HttpError(400,'Invalid subscriptions.'); }
            $changes=[];
            foreach (['add'=>1,'remove'=>0] as $key=>$active) {
                $list=$body[$key] ?? [];
                if (!is_array($list) || !array_is_list($list) || count($list)>50000) { throw new HttpError(400,'Invalid subscriptions.'); }
                foreach ($list as $url) { $url=self::url($url); $changes[hash('sha256',$url)]=[$url,$active]; }
            }
            $this->transaction($uid,function() use($uid,$device,$changes) {
                $this->device($uid,$device);
                foreach ($changes as $key=>[$url,$active]) {
                    $row=$this->query('SELECT active FROM ps_subscriptions WHERE user_id=? AND url_hash=?',[$uid,$key])->fetch();
                    if ($row && (int)$row['active'] === $active) { continue; }
                    if ($row) { $this->query('UPDATE ps_subscriptions SET active=?, changed_at=? WHERE user_id=? AND url_hash=?',[$active,time(),$uid,$key]); }
                    else { $this->query('INSERT INTO ps_subscriptions(user_id,url_hash,url,active,changed_at) VALUES(?,?,?,?,?)',[$uid,$key,$url,$active,time()]); }
                }
            });
            self::output(['timestamp'=>time(),'update_urls'=>[]]);
        }
        if ($method !== 'GET') { throw new HttpError(405,'Method not allowed.'); }
        $since=max(0,(int)($_GET['since'] ?? 0)-1);
        $rows=$this->query('SELECT url,active FROM ps_subscriptions WHERE user_id=? AND changed_at>=? ORDER BY url_hash',[$uid,$since]);
        $add=[]; $remove=[];
        foreach ($rows as $row) { if ((int)$row['active']===1) { $add[]=$row['url']; } else { $remove[]=$row['url']; } }
        self::output(['add'=>$add,'remove'=>$remove,'timestamp'=>time()]);
    }
    private function episodes(int $uid, string $method): never {
        if ($method === 'POST') {
            $body=$this->jsonBody();
            if (!is_array($body) || !array_is_list($body) || count($body)>50000) { throw new HttpError(400,'Invalid episode actions.'); }
            $actions=[];
            foreach ($body as $action) {
                if (!is_array($action)) { throw new HttpError(400,'Invalid episode action.'); }
                $a=['podcast'=>self::url($action['podcast']??null),'episode'=>self::url($action['episode']??null)];
                foreach (['guid'=>8192,'device'=>128] as $field=>$limit) {
                    $v=$action[$field]??'';
                    if (!is_string($v) || strlen($v)>$limit) { throw new HttpError(400,'Invalid episode metadata.'); }
                    $a[$field]=$v;
                }
                $type=$action['action']??'';
                if (!in_array($type,['play','new','download','delete','flattr'],true)) { throw new HttpError(400,'Invalid action type.'); }
                $a['action']=$type;
                $stamp=$action['timestamp']??null;
                if (!is_string($stamp) || !preg_match('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?$/D',$stamp)) { throw new HttpError(400,'Invalid action timestamp.'); }
                try { $date=new \DateTimeImmutable($stamp,new \DateTimeZone('UTC')); } catch (\Exception) { throw new HttpError(400,'Invalid action timestamp.'); }
                $epoch=$date->getTimestamp();
                if ($epoch<0 || $epoch>time()+86400) { throw new HttpError(400,'Action timestamp outside allowed range.'); }
                $a['timestamp']=$date->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s');
                if ($type==='play') {
                    foreach (['started','position','total'] as $field) {
                        $v=$action[$field]??0;
                        if (!is_int($v) || $v<0 || $v>2147483647) { throw new HttpError(400,'Invalid playback position.'); }
                        $a[$field]=$v;
                    }
                }
                $key=hash('sha256',$a['podcast']."\n".$a['episode']."\n".$type);
                $actions[]=[$key,$epoch,json_encode($a,JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR)];
            }
            $this->transaction($uid,function() use($uid,$actions) {
                foreach ($actions as [$key,$epoch,$json]) {
                    $old=$this->query('SELECT played_at,action_json FROM ps_actions WHERE user_id=? AND action_key=?',[$uid,$key])->fetch();
                    if ($old && ((int)$old['played_at']>$epoch || $old['action_json']===$json)) { continue; }
                    if ($old) { $this->query('UPDATE ps_actions SET played_at=?,received_at=?,action_json=? WHERE user_id=? AND action_key=?',[$epoch,time(),$json,$uid,$key]); }
                    else { $this->query('INSERT INTO ps_actions(user_id,action_key,played_at,received_at,action_json) VALUES(?,?,?,?,?)',[$uid,$key,$epoch,time(),$json]); }
                }
            });
            self::output(['timestamp'=>time(),'update_urls'=>[]]);
        }
        if ($method!=='GET') { throw new HttpError(405,'Method not allowed.'); }
        $since=max(0,(int)($_GET['since']??0)-1);
        $rows=$this->query('SELECT action_json FROM ps_actions WHERE user_id=? AND received_at>=? ORDER BY played_at,action_key',[$uid,$since]);
        $actions=[];
        foreach ($rows as $row) {
            $a=json_decode($row['action_json'],true,64,JSON_THROW_ON_ERROR);
            if (isset($_GET['podcast']) && $a['podcast']!==$_GET['podcast']) { continue; }
            if (isset($_GET['device']) && $a['device']!==$_GET['device']) { continue; }
            $actions[]=$a;
        }
        self::output(['actions'=>$actions,'timestamp'=>time()]);
    }
    public function run(): never {
        $method=$_SERVER['REQUEST_METHOD'];
        $path=rawurldecode((string)parse_url($_SERVER['REQUEST_URI'],PHP_URL_PATH));
        $base=rtrim((string)($this->config['base_path'] ?? ''),'/');
        if ($base!=='' && str_starts_with($path,$base.'/')) { $path=substr($path,strlen($base)); }
        if ($path==='/' || $path==='/health') {
            if ($method!=='GET') { throw new HttpError(405,'Method not allowed.'); }
            require_once __DIR__.'/PodcastLibrary.php';
            try { $transport=PodcastLibrary::transport(); } catch (HttpError $e) { $transport='unavailable'; }
            self::output(['service'=>'Von Podcast Sync','version'=>'1.1.1','api'=>'gpodder-2','queue_protocol'=>'vonqueue-v1','web_player'=>true,
                'feed_transport'=>$transport,'feed_parser'=>class_exists('DOMDocument')?'DOM':'unavailable']);
        }
        if ($path==='/api/2/queue-capabilities.json' && $method==='GET') {
            self::output(['protocol'=>'vonqueue-v1','ordered_queue'=>true,'three_way_merge'=>true]);
        }
        if (preg_match('#^/api/2/auth/([^/]+)/(login|logout)\.json$#D',$path,$m)) {
            if ($method!=='POST') { throw new HttpError(405,'Method not allowed.'); }
            $this->authenticate($m[1],$m[2]==='login');
            if ($m[2]==='logout') { $this->session(); $_SESSION=[]; session_destroy(); }
            self::output((object)[]);
        }
        if (!preg_match('#^/api/2/(devices|subscriptions|episodes|sync-devices|queue|library|discover)/([^/]+?)(?:/([^/]+))?\.json$#D',$path,$m)) {
            throw new HttpError(404,'Endpoint not found.');
        }
        $user=$this->authenticate($m[2]); $uid=(int)$user['id']; $kind=$m[1]; $device=$m[3]??null;
        if ($kind==='discover' && $device===null && $method==='GET') {
            $term=$_GET['q']??'';
            if (!is_string($term)) { throw new HttpError(400,'Invalid podcast search.'); }
            require_once __DIR__.'/PodcastLibrary.php';
            $library=new PodcastLibrary($this->config['feed_cache_path'] ?? dirname($this->config['session_path']).'/feeds');
            self::output($library->search($term));
        }
        if ($kind==='library' && $device===null && $method==='GET') {
            $feed=self::url($_GET['feed'] ?? null);
            $sub=$this->query('SELECT active FROM ps_subscriptions WHERE user_id=? AND url_hash=?',[$uid,hash('sha256',$feed)])->fetchColumn();
            $queued=false;
            foreach (json_decode($user['queue_json'],true,64,JSON_THROW_ON_ERROR) as $item) { if ($item['podcast']===$feed) { $queued=true; break; } }
            if ((int)$sub!==1 && !$queued) { throw new HttpError(403,'Subscribe to this podcast before browsing its episodes.'); }
            require_once __DIR__.'/PodcastLibrary.php';
            $library=new PodcastLibrary($this->config['feed_cache_path'] ?? dirname($this->config['session_path']).'/feeds');
            $result=$library->get($feed,($_GET['refresh']??'')==='1');
            if (($_GET['summary']??'')==='1') { unset($result['episodes']); }
            self::output($result);
        }
        if ($kind==='subscriptions' && $device!==null) { $this->subscriptions($uid,$device,$method); }
        if ($kind==='episodes' && $device===null) { $this->episodes($uid,$method); }
        if ($kind==='devices') {
            if ($device!==null && $method==='POST') {
                $body=$this->jsonBody(); if (!is_array($body)) { throw new HttpError(400,'Invalid device.'); }
                $this->transaction($uid,fn()=>$this->device($uid,$device,$body));
                self::output((object)[]);
            }
            if ($device===null && $method==='GET') {
                $count=(int)$this->query('SELECT count(*) FROM ps_subscriptions WHERE user_id=? AND active=1',[$uid])->fetchColumn();
                $out=[];
                foreach ($this->query('SELECT * FROM ps_devices WHERE user_id=? ORDER BY device_id',[$uid]) as $d) {
                    $out[]=['id'=>$d['device_id'],'caption'=>$d['caption'],'type'=>$d['device_type'],'subscriptions'=>$count];
                }
                self::output($out);
            }
        }
        if ($kind==='sync-devices' && $device===null && in_array($method,['GET','POST'],true)) {
            if ($method==='POST') {
                $body=$this->jsonBody();
                if (!empty($body['stop-synchronize'])) { throw new HttpError(400,'All devices on this personal account share subscriptions. Use a separate account to isolate a device.'); }
                foreach ($body['synchronize']??[] as $group) {
                    if (!is_array($group)) { throw new HttpError(400,'Invalid device group.'); }
                    foreach ($group as $d) { self::identifier($d); }
                }
            }
            $ids=$this->query('SELECT device_id FROM ps_devices WHERE user_id=? ORDER BY device_id',[$uid])->fetchAll(PDO::FETCH_COLUMN);
            self::output(['synchronized'=>count($ids)>1?[$ids]:[],'not-synchronized'=>count($ids)>1?[]:$ids]);
        }
        if ($kind==='queue' && $device!==null) {
            self::identifier($device);
            if ($method==='POST') {
                $body=$this->jsonBody(); if (!is_array($body)) { throw new HttpError(400,'Invalid queue request.'); }
                self::output($this->syncQueue($uid,$device,$body));
            }
            if ($method==='GET') {
                $fresh=$this->query('SELECT queue_revision,queue_json FROM ps_users WHERE id=?',[$uid])->fetch();
                self::output(['protocol'=>'vonqueue-v1','revision'=>(int)$fresh['queue_revision'],'items'=>json_decode($fresh['queue_json'],true,64,JSON_THROW_ON_ERROR)]);
            }
        }
        throw new HttpError(405,'Method not allowed.');
    }
}
