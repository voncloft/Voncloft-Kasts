<?php
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (in_array($path, ['/dashboard', '/dashboard/', '/dashboard/index.php', '/dashboard/app.css', '/dashboard/app.js'], true)) {
    return false;
}
if (preg_match('#^/downloads/[a-zA-Z0-9._-]+\.apk$#D', $path) && is_file(__DIR__.$path)) { return false; }
require __DIR__ . '/index.php';
