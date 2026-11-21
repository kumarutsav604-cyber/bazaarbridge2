-- BazaarBridge Financial & Order Reconciliation Check
-- Must return ZERO rows.
SELECT o.order_id,
       o.total_amount,
       coalesce(sum(oi.paid_amount), 0) AS items_paid_sum
  FROM orders o
  LEFT JOIN order_items oi ON oi.order_id = o.order_id
 GROUP BY o.order_id, o.total_amount
HAVING o.total_amount <> coalesce(sum(oi.paid_amount), 0);
