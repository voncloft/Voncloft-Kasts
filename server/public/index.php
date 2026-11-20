<?php
declare(strict_types=1);
require dirname(__DIR__) . '/src/Server.php';
try {
    $file = getenv('PODSYNC_CONFIG') ?: dirname(__DIR__) . '/config/config.php';
    if (!is_file($file)) {
        throw new RuntimeException('Server has not been configured.');
    }
    $server = new PodcastSync\Server(require $file);
    $server->run();
} catch (PodcastSync\HttpError $e) {
    http_response_code($e->status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(['error' => $e->getMessage()], JSON_UNESCAPED_SLASHES);
} catch (Throwable $e) {
    error_log('Podcast Sync: ' . get_class($e) . ' (request failed)');
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo '{"error":"Server error. Check server configuration and PHP error log."}';
}
