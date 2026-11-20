#!/usr/bin/env php
<?php
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require dirname(__DIR__) . '/src/Server.php';
try {
    $config=getenv('PODSYNC_CONFIG') ?: dirname(__DIR__) . '/config/config.php';
    if (!is_file($config)) { throw new RuntimeException('Copy config/config.example.php to config/config.php and set database credentials first.'); }
    $server=new PodcastSync\Server(require $config);
    if (($argv[1]??'')==='install') { $server->install(); echo "Database tables and session directory are ready.\n"; }
    elseif (($argv[1]??'')==='add-user' && isset($argv[2])) {
        fwrite(STDERR,"New password (12+ characters): ");
        $tty=function_exists('stream_isatty') && stream_isatty(STDIN);
        if ($tty) { system('stty -echo'); }
        try { $password=rtrim((string)fgets(STDIN),"\r\n"); }
        finally { if ($tty) { system('stty echo'); fwrite(STDERR,"\n"); } }
        $server->addUser($argv[2],$password); unset($password);
        echo "User created. Use this account in both clients with different device names.\n";
    } else { fwrite(STDERR,"Usage: php bin/manage.php install | add-user USERNAME\n"); exit(1); }
} catch (Throwable $e) { fwrite(STDERR,"Setup failed: ".$e->getMessage()."\n"); exit(1); }
