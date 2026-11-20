<?php
declare(strict_types=1);
return [
    'dsn' => 'mysql:host=localhost;dbname=podcast_sync;charset=utf8mb4',
    'db_user' => 'podcast_sync',
    'db_password' => 'CHANGE_ME',
    'base_path' => '', // For a subdirectory installation, for example '/podsync'.
    'session_path' => dirname(__DIR__) . '/var/sessions',
    'max_body_bytes' => 16777216,
];
