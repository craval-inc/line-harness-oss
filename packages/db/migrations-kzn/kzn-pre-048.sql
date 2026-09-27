-- kzn-pre-048.sql — 本家 048_chats_friend_unique.sql の直前に1回だけ実行（kzn 専用・冪等）。
-- 048 は chats の friend_id 重複を統合して一意インデックスを張るが、kzn 専用列
-- chats.last_incoming_event_at（K001）は統合の対象外。削除される行の値を失わないよう、
-- 同じ friend の全行に MAX を先に揃えておく（重複が無ければ実質何も変わらない）。
UPDATE chats
   SET last_incoming_event_at = (
     SELECT MAX(c2.last_incoming_event_at) FROM chats c2 WHERE c2.friend_id = chats.friend_id
   )
 WHERE friend_id IN (SELECT friend_id FROM chats GROUP BY friend_id HAVING COUNT(*) > 1);
