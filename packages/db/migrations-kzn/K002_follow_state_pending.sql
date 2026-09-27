-- K002_follow_state_pending.sql — [Craval kzn] kzn 専用・追記 migration（K001 の後）。追加のみ。
-- 友だち行（friends）が作られる前に受けた unfollow の履歴を保持する。
-- friend_follow_state は最新状態しか持たないため、「初回 follow の処理中に unfollow → 再 follow」のように
-- 友だち行の作成前に状態が往復すると、解除回数・解除日時が失われていた（CODEX v0.24 再レビュー Med）。
-- 行を作る時にこの保留分を friends.unfollow_count / last_unfollowed_at に畳み込み、同じ batch で 0 に戻す。
ALTER TABLE friend_follow_state ADD COLUMN pending_unfollow_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE friend_follow_state ADD COLUMN pending_last_unfollowed_at INTEGER;
