<?php
declare(strict_types=1);
namespace PodcastSync;

/** Fetch and cache publisher feeds. Audio and artwork go straight to the browser. */
final class PodcastLibrary {
    private const MAX_BYTES = 16777216;
    public function __construct(private string $cacheDir) {}

    public static function transport(): string {
        if (ini_get('allow_url_fopen') && in_array('https', stream_get_wrappers(), true)) { return 'PHP HTTPS'; }
        if (self::curlBinary() !== null) { return 'system cURL'; }
        throw new HttpError(503, 'Feed downloads need PHP HTTPS support, or the system curl command with HTTPS support and PHP proc_open enabled. Your website can still use HTTP.');
    }

    private static function curlBinary(): ?string {
        static $checked = false, $binary = null;
        if ($checked) { return $binary; }
        $checked = true;
        if (!function_exists('proc_open') || !function_exists('proc_get_status') || !function_exists('proc_terminate')) { return null; }
        foreach (['/usr/bin/curl', '/bin/curl', '/usr/local/bin/curl'] as $candidate) {
            if (!is_executable($candidate)) { continue; }
            try {
                [$output, $code] = self::process([$candidate, '--disable', '--version'], '', microtime(true) + 3, 16384);
                if ($code === 0 && preg_match('/^Protocols:.*\bhttps\b/im', $output)) { $binary = $candidate; return $binary; }
            } catch (HttpError $e) { continue; }
        }
        return null;
    }

    /** Arguments bypass the shell. Private feed URLs are sent over stdin, not argv. */
    private static function process(array $command, string $input, float $deadline, int $limit): array {
        $pipes = [];
        $process = @proc_open($command, [0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']], $pipes, null, null, ['bypass_shell'=>true]);
        if (!is_resource($process)) { throw new HttpError(503, 'PHP could not start the system curl command. Check PHP process permissions.'); }
        $output = ''; $exit = null; $completed = false;
        try {
            $offset = 0;
            while ($offset < strlen($input)) {
                $written = @fwrite($pipes[0], substr($input, $offset));
                if (!$written) { throw new HttpError(502, 'Could not send the feed request to curl.'); }
                $offset += $written;
            }
            fclose($pipes[0]); unset($pipes[0]);
            stream_set_blocking($pipes[1], false); stream_set_blocking($pipes[2], false);
            while (true) {
                if (microtime(true) >= $deadline) { throw new HttpError(504, 'The publisher took too long to respond.'); }
                $state = proc_get_status($process);
                if (!$state['running'] && $exit === null) { $exit = $state['exitcode']; }
                $read = [];
                foreach ($pipes as $pipe) { if (!feof($pipe)) { $read[] = $pipe; } }
                if (!$state['running'] && !$read) { break; }
                if (!$read) { usleep(10000); continue; }
                $write = null; $except = null;
                $selected = @stream_select($read, $write, $except, 0, 100000);
                if ($selected === false) { throw new HttpError(502, 'Could not read the curl response.'); }
                foreach ($read as $pipe) {
                    $chunk = fread($pipe, 65536);
                    if ($chunk === false) { throw new HttpError(502, 'Could not read the curl response.'); }
                    // Drain stderr without exposing publisher URLs or private feed tokens.
                    if ($pipe === $pipes[1]) {
                        $output .= $chunk;
                        if (strlen($output) > $limit) { throw new HttpError(413, 'The publisher feed exceeds the download limit.'); }
                    }
                }
            }
            $completed = true;
        } finally {
            if (!$completed) { @proc_terminate($process, 9); }
            foreach ($pipes as $pipe) { if (is_resource($pipe)) { fclose($pipe); } }
            $closed = proc_close($process);
            if ($exit === null || $exit < 0) { $exit = $closed; }
        }
        return [$output, $exit];
    }

    private static function curlRequest(string $url, string $host, int $port, string $ip, float $deadline): array {
        $binary = self::curlBinary();
        if ($binary === null) { throw new HttpError(503, 'PHP cannot use the system curl command for HTTPS downloads.'); }
        $remaining = $deadline - microtime(true);
        if ($remaining <= 0) { throw new HttpError(504, 'The publisher took too long to respond.'); }
        $command = [$binary, '--disable', '--silent', '--show-error', '--globoff', '--include',
            '--proxy', '', '--noproxy', '*', '--proto', '=http,https',
            '--connect-timeout', sprintf('%.3F', min(8, $remaining)), '--max-time', sprintf('%.3F', $remaining),
            '--max-filesize', (string)self::MAX_BYTES, '--user-agent', 'VonPodcastSync/1.1.3',
            '--header', 'Accept-Encoding: identity', '--header', 'Accept: application/rss+xml, application/atom+xml, application/xml, application/json, text/xml, */*'];
        if (@inet_pton($host) === false) {
            $command[] = '--resolve';
            $command[] = $host.':'.$port.':'.(str_contains($ip, ':') ? '['.$ip.']' : $ip);
        }
        $command[] = '--config'; $command[] = '-';
        $input = 'url = "'.str_replace(['\\', '"'], ['\\\\', '\\"'], $url).'"'."\n";
        [$raw, $code] = self::process($command, $input, $deadline, self::MAX_BYTES + 65536);
        if ($code !== 0) {
            if ($code === 28) { throw new HttpError(504, 'The publisher download timed out.'); }
            if ($code === 63) { throw new HttpError(413, 'The publisher feed exceeds the 16 MiB feed limit.'); }
            if (in_array($code, [51,58,60,77,83,90,91], true)) { throw new HttpError(502, 'curl could not verify the publisher certificate. Check the server CA certificates.'); }
            throw new HttpError(502, 'curl could not fetch the publisher feed (exit '.$code.'). Check server DNS and internet access.');
        }
        $headerBytes = 0;
        for ($block = 0; $block < 8; $block++) {
            $end = strpos($raw, "\r\n\r\n"); $separator = 4;
            if ($end === false) { $end = strpos($raw, "\n\n"); $separator = 2; }
            if ($end === false || ($headerBytes += $end + $separator) > 65536) { throw new HttpError(502, 'The publisher returned invalid HTTP headers.'); }
            $headers = substr($raw, 0, $end); $raw = substr($raw, $end + $separator);
            if (!preg_match('#^HTTP/\S+ (\d{3})#', $headers, $match)) { throw new HttpError(502, 'The publisher returned an invalid HTTP response.'); }
            $status = (int)$match[1];
            if ($status >= 100 && $status < 200) { continue; }
            $location = preg_match('/^Location:\s*(.+)$/mi', $headers, $match) ? trim($match[1]) : null;
            if (strlen($raw) > self::MAX_BYTES) { throw new HttpError(413, 'The publisher feed exceeds the 16 MiB feed limit.'); }
            return [$status, $location, $raw];
        }
        throw new HttpError(502, 'The publisher returned too many interim responses.');
    }

    public function search(string $term): array {
        $term=trim($term);
        if (strlen($term)<2 || strlen($term)>160 || preg_match('/[\x00-\x1f]/', $term)) { throw new HttpError(400, 'Search using 2 to 160 characters.'); }
        if (!is_dir($this->cacheDir)) { @mkdir($this->cacheDir,0700,true); }
        $file=$this->cacheDir.'/search-'.hash('sha256',strtolower($term)).'.json';
        $cached=is_file($file)?json_decode((string)@file_get_contents($file),true):null;
        if (is_array($cached) && ($cached['fetched_at']??0)>time()-3600) { return $cached; }
        [$raw]=self::download('https://itunes.apple.com/search?media=podcast&entity=podcast&country=US&limit=30&term='.rawurlencode($term));
        $json=json_decode($raw,true);
        if (!is_array($json) || !isset($json['results'])) { throw new HttpError(502,'The podcast directory returned an invalid response. Try again later.'); }
        $results=[];$seen=[];
        foreach ($json['results'] as $item) {
            $url=self::absolute((string)($item['feedUrl']??''),'https://itunes.apple.com/');
            if ($url==='' || isset($seen[$url])) { continue; } $seen[$url]=true;
            $results[]=['url'=>$url,'title'=>self::text((string)($item['collectionName']??$item['trackName']??'Podcast')),
                'author'=>self::text((string)($item['artistName']??'')),
                'image'=>self::absolute((string)($item['artworkUrl600']??$item['artworkUrl100']??''),'https://itunes.apple.com/'),
                'website'=>self::absolute((string)($item['collectionViewUrl']??$item['trackViewUrl']??''),'https://podcasts.apple.com/')];
        }
        $result=['provider'=>'Apple Podcasts','results'=>$results,'fetched_at'=>time()];
        $temp=@tempnam($this->cacheDir,'.search-');
        if ($temp!==false) {
            if (@file_put_contents($temp,json_encode($result,JSON_UNESCAPED_SLASHES))!==false) { @rename($temp,$file); }
            if (is_file($temp)) { @unlink($temp); }
        }
        return $result;
    }

    public function get(string $url, bool $refresh = false): array {
        if (!is_dir($this->cacheDir) && !@mkdir($this->cacheDir, 0700, true) && !is_dir($this->cacheDir)) {
            throw new HttpError(503, 'The feed cache is not writable. Check the server/var directory permissions.');
        }
        $file = $this->cacheDir . '/' . hash('sha256', $url) . '.json';
        $cached = is_file($file) ? json_decode((string)@file_get_contents($file), true) : null;
        if (is_array($cached) && ($cached['fetched_at'] ?? 0) > time() - ($refresh ? 60 : 900)) { return $cached; }
        $lock = @fopen($file . '.lock', 'c');
        if (!$lock) { throw new HttpError(503, 'The feed cache is not writable.'); }
        @chmod($file . '.lock', 0600);
        if (!flock($lock, LOCK_EX | LOCK_NB)) {
            fclose($lock);
            if (is_array($cached)) { $cached['stale'] = true; return $cached; }
            throw new HttpError(429, 'This feed is already loading. Try again shortly.');
        }
        try {
            [$xml, $finalUrl] = self::download($url);
            $feed = self::parse($xml, $url, $finalUrl);
            $feed['fetched_at'] = time();
            $feed['stale'] = false;
            $temp = tempnam($this->cacheDir, '.feed-');
            if ($temp === false) { throw new HttpError(503, 'The feed cache is not writable.'); }
            try {
                if (file_put_contents($temp, json_encode($feed, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR)) === false || !rename($temp, $file)) {
                    throw new HttpError(503, 'Could not save the feed cache.');
                }
            } finally { if (is_file($temp)) { unlink($temp); } }
            return $feed;
        } catch (HttpError $e) {
            if (is_array($cached)) { $cached['stale'] = true; $cached['warning'] = $e->getMessage(); return $cached; }
            throw $e;
        } finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    public static function publicIp(string $ip): bool {
        // Reject all non-global destinations, including IPv4-mapped IPv6 and NAT64.
        if (@inet_pton($ip) === false) { return false; }
        if (str_contains($ip, ':')) {
            $packed = inet_pton($ip);
            if (!$packed || (ord($packed[0]) & 0xe0) !== 0x20) { return false; }
            $prefix = unpack('N', substr($packed, 0, 4))[1];
            if (($prefix & 0xfffffe00) === 0x20010000 || $prefix === 0x20010db8 || ($prefix & 0xffff0000) === 0x20020000) { return false; }
        } else {
            $n = unpack('N', inet_pton($ip))[1];
            foreach ([[0,8],[0x0a000000,8],[0x64400000,10],[0x7f000000,8],[0xa9fe0000,16],[0xac100000,12],
                      [0xc0000000,24],[0xc0000200,24],[0xc0a80000,16],[0xc6120000,15],[0xc6336400,24],[0xcb007100,24],[0xe0000000,3]] as [$base,$bits]) {
                $mask = (0xffffffff << (32-$bits)) & 0xffffffff;
                if (($n & $mask) === $base) { return false; }
            }
        }
        return true;
    }

    private static function destination(string $url): array {
        $p = parse_url($url);
        if (is_array($p) && isset($p['scheme'])) { $p['scheme'] = strtolower($p['scheme']); }
        if (!$p || strlen($url) > 8192 || preg_match('/[\x00-\x20\\\\]/', $url) || isset($p['user']) || isset($p['pass'])
            || !in_array($p['scheme'] ?? '', ['http','https'], true) || empty($p['host'])) {
            throw new HttpError(400, 'Feed addresses must be HTTP or HTTPS URLs without embedded credentials.');
        }
        $host = trim($p['host'], '[]');
        $port = $p['port'] ?? ($p['scheme'] === 'https' ? 443 : 80);
        if (!in_array($port, [80,443], true)) { throw new HttpError(400, 'Publisher feeds must use port 80 or 443.'); }
        if (@inet_pton($host) !== false) { $ips = [$host]; }
        else {
            if (!preg_match('/^[a-zA-Z0-9.-]+$/D', $host)) { throw new HttpError(400, 'Invalid feed hostname.'); }
            $ips = @gethostbynamel($host) ?: [];
            if (!$ips) {
                foreach (@dns_get_record($host, DNS_AAAA) ?: [] as $row) { if (isset($row['ipv6'])) { $ips[] = $row['ipv6']; } }
            }
        }
        if (!$ips) { throw new HttpError(502, 'The publisher hostname could not be resolved. Try again later.'); }
        foreach ($ips as $ip) { if (!self::publicIp($ip)) { throw new HttpError(400, 'The feed points to a local or reserved network address.'); } }
        return [$p, $host, $port, $ips];
    }

    private static function download(string $url): array {
        $transport = self::transport();
        $deadline = microtime(true) + 22;
        for ($redirect = 0; $redirect <= 5; $redirect++) {
            [$p, $host, $port, $ips] = self::destination($url);
            $ip = $ips[0];
            if ($transport === 'system cURL') {
                [$status, $location, $body] = self::curlRequest($url, $host, $port, $ip, $deadline);
                if (in_array($status, [301,302,303,307,308], true) && $location !== null) {
                    $url = self::absolute($location, $url);
                    if ($url === '') { throw new HttpError(502, 'The publisher returned an invalid redirect.'); }
                    continue;
                }
                if ($status !== 200) { throw new HttpError(502, 'The publisher returned HTTP '.$status.'. Try again later.'); }
                return [$body, $url];
            }
            $pinned = $p['scheme'].'://'.(str_contains($ip, ':') ? '['.$ip.']' : $ip).':'.$port.($p['path'] ?? '/').(isset($p['query']) ? '?'.$p['query'] : '');
            $hostHeader = $p['host'].(isset($p['port']) ? ':'.$port : '');
            $remaining = $deadline - microtime(true);
            if ($remaining <= 0) { throw new HttpError(504, 'The publisher took too long to respond.'); }
            $context = stream_context_create([
                'http' => ['method'=>'GET', 'header'=>"Host: $hostHeader\r\nUser-Agent: VonPodcastSync/1.1\r\nAccept: application/rss+xml, application/atom+xml, application/xml, text/xml, */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n",
                    'follow_location'=>0, 'ignore_errors'=>true, 'timeout'=>min(10, $remaining), 'protocol_version'=>1.1],
                'ssl' => ['peer_name'=>$host, 'SNI_enabled'=>true, 'verify_peer'=>true, 'verify_peer_name'=>true, 'allow_self_signed'=>false],
            ]);
            $stream = @fopen($pinned, 'rb', false, $context);
            if (!$stream) { throw new HttpError(502, 'Could not connect securely to the publisher. Check server DNS, internet access and CA certificates.'); }
            $metadata = stream_get_meta_data($stream);
            $headers = $metadata['wrapper_data'] ?? [];
            $status = 0; $location = null;
            foreach ($headers as $header) {
                if (preg_match('#^HTTP/\S+ (\d+)#', $header, $m)) { $status = (int)$m[1]; }
                if (stripos($header, 'Location:') === 0) { $location = trim(substr($header, 9)); }
            }
            if (in_array($status, [301,302,303,307,308], true) && $location !== null) {
                fclose($stream); $url = self::absolute($location, $url);
                if ($url === '') { throw new HttpError(502, 'The publisher returned an invalid redirect.'); }
                continue;
            }
            if ($status !== 200) { fclose($stream); throw new HttpError(502, 'The publisher returned HTTP '.$status.'. Try again later.'); }
            $body = '';
            try {
                while (!feof($stream)) {
                    $remaining = $deadline - microtime(true);
                    if ($remaining <= 0) { throw new HttpError(504, 'The publisher took too long to respond.'); }
                    stream_set_timeout($stream, max(1, (int)ceil(min(5, $remaining))));
                    $chunk = fread($stream, 65536);
                    if ($chunk === false || stream_get_meta_data($stream)['timed_out']) { throw new HttpError(504, 'The feed download timed out.'); }
                    $body .= $chunk;
                    if (strlen($body) > self::MAX_BYTES) { throw new HttpError(413, 'The publisher feed exceeds the 16 MiB feed limit.'); }
                }
            } finally { fclose($stream); }
            return [$body, $url];
        }
        throw new HttpError(502, 'The publisher redirected too many times.');
    }

    public static function absolute(string $value, string $base): string {
        $value = trim($value);
        if ($value === '' || preg_match('/[\x00-\x20\\\\]/', $value)) { return ''; }
        if (str_starts_with($value, '//')) { $value = (parse_url($base, PHP_URL_SCHEME) ?: 'https').':'.$value; }
        elseif (!preg_match('/^[a-zA-Z][a-zA-Z0-9+.-]*:/', $value)) {
            $p = parse_url($base);
            if (!$p || empty($p['host'])) { return ''; }
            $origin = $p['scheme'].'://'.$p['host'].(isset($p['port']) ? ':'.$p['port'] : '');
            $path = $p['path'] ?? '/';
            if ($value[0] === '?') { $value = $origin.$path.$value; }
            elseif ($value[0] === '/') { $value = $origin.$value; }
            else { $value = $origin.substr($path, 0, (int)strrpos($path, '/') + 1).$value; }
        }
        $p = parse_url($value);
        if (!$p || strlen($value) > 8192 || !in_array(strtolower($p['scheme'] ?? ''), ['http','https'], true)
            || empty($p['host']) || isset($p['user']) || isset($p['pass'])) { return ''; }
        $parts = [];
        foreach (explode('/', $p['path'] ?? '/') as $part) {
            if ($part === '..') { array_pop($parts); } elseif ($part !== '.') { $parts[] = $part; }
        }
        return strtolower($p['scheme']).'://'.$p['host'].(isset($p['port']) ? ':'.$p['port'] : '').implode('/', $parts)
            .(isset($p['query']) ? '?'.$p['query'] : '');
    }

    private static function text(string $value, int $max = 2048): string {
        $value = preg_replace('/<(?:br\s*\/?|\/p|\/div)>/i', "\n", $value);
        $value = trim(html_entity_decode(strip_tags($value), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
        $value = preg_replace('/[\x00-\x08\x0b\x0c\x0e-\x1f]/', '', $value);
        // Byte limits match the queue protocol, without cutting a UTF-8 character.
        $value = substr($value, 0, $max);
        while ($value !== '' && !preg_match('//u', $value)) { $value = substr($value, 0, -1); }
        return $value;
    }

    public static function parse(string $xml, string $url, ?string $documentUrl = null): array {
        if (!class_exists('DOMDocument')) { throw new HttpError(503, 'Feed loading needs the PHP DOM/XML extension.'); }
        if (strlen($xml) > self::MAX_BYTES || preg_match('/<!\s*(?:DOCTYPE|ENTITY)/i', $xml)) { throw new HttpError(400, 'Feed XML is too large or contains a document type declaration.'); }
        $documentUrl ??= $url;
        $previous = libxml_use_internal_errors(true);
        $doc = new \DOMDocument(); $doc->resolveExternals = false; $doc->substituteEntities = false;
        try { $valid = $doc->loadXML($xml, LIBXML_NONET | LIBXML_COMPACT); }
        finally { libxml_clear_errors(); libxml_use_internal_errors($previous); }
        if (!$valid) { throw new HttpError(502, 'The publisher did not return valid podcast XML.'); }
        if ($doc->doctype !== null) { throw new HttpError(400, 'Feed XML must not contain a document type declaration.'); }
        $xp = new \DOMXPath($doc);
        $query = static fn(string $path, \DOMNode $node) => $xp->query($path, $node);
        $value = static fn(string $path, \DOMNode $node): string => trim((string)$xp->evaluate('string('.$path.')', $node));
        $root = $doc->documentElement;
        $channel = $query('./*[local-name()="channel"]', $root)->item(0) ?? $root;
        if (!in_array($root->localName, ['rss','RDF','feed'], true)) { throw new HttpError(502, 'This address is not an RSS or Atom feed.'); }
        $title = self::text($value('./*[local-name()="title"][1]', $channel)) ?: self::text($url);
        $image = static function(\DOMNode $node) use ($value, $documentUrl): string {
            foreach (['./*[local-name()="image"]/@href','./*[local-name()="image"]/*[local-name()="url"]','./*[local-name()="thumbnail"]/@url','./*[local-name()="logo"]','./*[local-name()="icon"]'] as $path) {
                $found = self::absolute($value($path, $node), $documentUrl); if ($found !== '') { return $found; }
            }
            return '';
        };
        $artwork = $image($channel);
        $description = $value('./*[local-name()="description" or local-name()="subtitle"][1]', $channel);
        $items = $query('./*[local-name()="item" or local-name()="entry"]', $channel);
        if ($root->localName === 'RDF') { $items = $query('./*[local-name()="item"]', $root); }
        $episodes = []; $seen = [];
        foreach ($items as $node) {
            $media = '';
            foreach ($query('./*[local-name()="enclosure"] | ./*[local-name()="link" and @rel="enclosure"] | ./*[local-name()="content" and @url]', $node) as $enclosure) {
                $type = strtolower($enclosure->getAttribute('type'));
                if ($type !== '' && !str_starts_with($type, 'audio/') && !str_starts_with($type, 'video/') && $type !== 'application/octet-stream') { continue; }
                $media = self::absolute($enclosure->getAttribute('url') ?: $enclosure->getAttribute('href'), $documentUrl);
                if ($media !== '') { break; }
            }
            if ($media === '') { continue; }
            $guid = $value('./*[local-name()="guid" or local-name()="id"][1]', $node) ?: $media;
            if (strlen($guid) > 8192) { continue; }
            if (isset($seen[$guid])) { continue; } $seen[$guid] = true;
            $rawDuration = $value('./*[local-name()="duration"][1]', $node); $duration = 0;
            if (preg_match('/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/D', $rawDuration)) {
                foreach (explode(':', $rawDuration) as $part) { $duration = $duration * 60 + (int)$part; }
            }
            $published = strtotime($value('./*[local-name()="pubDate" or local-name()="published" or local-name()="date" or local-name()="updated"][1]', $node)) ?: 0;
            $descriptionText = $value('./*[local-name()="encoded" or local-name()="description" or local-name()="summary" or (local-name()="content" and not(@url))][1]', $node);
            $episodes[] = ['podcast'=>$url,'episode'=>$media,'guid'=>$guid,'title'=>self::text($value('./*[local-name()="title"][1]', $node)) ?: 'Untitled episode',
                'podcast_title'=>$title,'published'=>max(0, min(2147483647, $published)), 'duration'=>max(0, min(2147483647, $duration)),
                'image'=>$image($node) ?: $artwork,'description'=>self::text($descriptionText, 6000)];
            if (count($episodes) >= 2000) { break; }
        }
        usort($episodes, static fn($a,$b) => $b['published'] <=> $a['published']);
        return ['url'=>$url,'title'=>$title,'image'=>$artwork,'description'=>self::text($description, 8000),
            'episodes'=>$episodes,'episode_count'=>count($episodes),'limited'=>count($episodes) >= 2000];
    }
}
