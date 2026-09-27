-- K002_follow_state_pending.sql — [Craval kzn] kzn 専用・追記 migration（K001 の後）。追加のみ。
-- 友だち行（friends）が作られる前に受けた unfollow の履歴を保持する。
-- friend_follow_state は最新状態しか持たないため、「初回 follow の処理中に unfollow → 再 follow」のように
-- 友だち行の作成前に状態が往復すると、解除回数・解除日時が失われていた（CODEX v0.24 再レビュー Med）。
-- 行を作る時にこの保留分を friends.unfollow_count / last_unfollowed_at に畳み込み、同じ batch で 0 に戻す。
ALTER TABLE friend_follow_state ADD COLUMN pending_unfollow_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE friend_follow_state ADD COLUMN pending_last_unfollowed_at INTEGER;

-- 既存データの引継ぎ: K002 適用前に記録された「友だち行が無い・unfollow 状態」は、行作成前の解除 1 回として保留に移す
-- （K002 前の実装はこの状態から友だち行を作る時に解除回数 1・解除日時＝状態時刻としていた。同じ意味を保つ）。
-- 友だち行がある人は friends 側に記録済みなので対象外。1回だけ実行する前提だが、保留 0 の行だけを対象にして冪等にする。
UPDATE friend_follow_state
   SET pending_unfollow_count = 1,
       pending_last_unfollowed_at = state_at
 WHERE is_following = 0
   AND pending_unfollow_count = 0
   AND NOT EXISTS (SELECT 1 FROM friends f WHERE f.line_user_id = friend_follow_state.line_user_id);
