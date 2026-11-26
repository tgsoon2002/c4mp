<?php

require __DIR__ . "/../src/Models/Order.php";
require_once dirname(__DIR__) . "/views/list.php";
include 'missing.php';
$page = $_GET['page'];
include $page . ".php";
include "pages/{$page}.php";
require __DIR__ . "/../vendor/autoload.php";
