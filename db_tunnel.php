<?php
header('Content-Type: application/json; charset=utf-8');

// Secret token to secure access to the tunnel
define('API_KEY', 'EASY_CRM_TUNNEL_KEY_2026_SECURE_9281');

// Get request headers
$headers = [];
foreach ($_SERVER as $name => $value) {
    if (substr($name, 0, 5) == 'HTTP_') {
        $headers[str_replace(' ', '-', ucwords(strtolower(str_replace('_', ' ', substr($name, 5)))))] = $value;
    }
}

$authToken = isset($headers['X-Auth-Token']) ? $headers['X-Auth-Token'] : '';
if ($authToken !== API_KEY) {
    header('HTTP/1.1 401 Unauthorized');
    echo json_encode(['error' => 'Unauthorized access to DB tunnel']);
    exit;
}

// Read raw JSON post request
$input = json_decode(file_get_contents('php://input'), true);
if (!$input || !isset($input['query'])) {
    header('HTTP/1.1 400 Bad Request');
    echo json_encode(['error' => 'Missing SQL query']);
    exit;
}

$query = $input['query'];
$params = isset($input['params']) ? $input['params'] : [];

$db_host = isset($input['db_host']) ? $input['db_host'] : 'localhost';
$db_port = isset($input['db_port']) ? $input['db_port'] : 3306;
$db_name = isset($input['db_name']) ? $input['db_name'] : '';
$db_user = isset($input['db_user']) ? $input['db_user'] : '';
$db_pass = isset($input['db_pass']) ? $input['db_pass'] : '';

if (!$db_name || !$db_user) {
    header('HTTP/1.1 400 Bad Request');
    echo json_encode(['error' => 'Missing DB connection parameters']);
    exit;
}

try {
    $dsn = "mysql:host=$db_host;port=$db_port;dbname=$db_name;charset=utf8mb4";
    $pdo = new PDO($dsn, $db_user, $db_pass, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::MYSQL_ATTR_INIT_COMMAND => "SET sql_mode = CONCAT(@@sql_mode, ',PIPES_AS_CONCAT')"
    ]);
    
    $stmt = $pdo->prepare($query);
    $stmt->execute($params);
    
    $result = [];
    $is_select = (stripos($query, 'SELECT') === 0 || stripos($query, 'SHOW') === 0 || stripos($query, 'PRAGMA') === 0);
    
    if ($is_select) {
        $result['rows'] = $stmt->fetchAll();
    } else {
        $result['affected_rows'] = $stmt->rowCount();
        $result['last_insert_id'] = $pdo->lastInsertId();
    }
    
    echo json_encode($result);
} catch (Exception $e) {
    header('HTTP/1.1 500 Internal Server Error');
    echo json_encode(['error' => $e->getMessage()]);
}
