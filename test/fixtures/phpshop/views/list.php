<html>
<body>
<?php
function render_row(array $order): string
{
    return '<li>' . $order['id'] . '</li>';
}
?>
<ul>
<?php foreach ($orders as $order): ?>
  <?= render_row($order) ?>
<?php endforeach; ?>
</ul>
<?php
class ListView
{
    public function title(): string
    {
        return 'Orders';
    }
}
?>
</body>
</html>
