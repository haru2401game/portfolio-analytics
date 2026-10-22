-- いいね（サイト全体）。日ごとに合計する
CREATE TABLE IF NOT EXISTS likes_daily (
    day   TEXT PRIMARY KEY,             -- 日本時間の日付 YYYY-MM-DD
    count INTEGER NOT NULL DEFAULT 0
);

-- 連打は自由。ただしプログラムによる大量送信を防ぐため、訪問ごとの1日の上限に使う
CREATE TABLE IF NOT EXISTS like_sessions (
    session TEXT NOT NULL,
    day     TEXT NOT NULL,
    count   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session, day)
);
