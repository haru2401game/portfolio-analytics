-- ポートフォリオのアクセス記録
-- 個人を特定できる情報（IPアドレス・Cookie・端末ID）は保存しない
CREATE TABLE IF NOT EXISTS events (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       INTEGER NOT NULL,          -- 記録時刻（UNIXミリ秒）
    day      TEXT    NOT NULL,          -- 日本時間の日付 YYYY-MM-DD
    type     TEXT    NOT NULL,          -- pageview / section_view / work_click など
    name     TEXT    NOT NULL DEFAULT '',
    session  TEXT    NOT NULL,          -- タブを閉じると消えるランダムID（訪問の区別のみ）
    referrer TEXT    NOT NULL DEFAULT '', -- 流入元のドメインのみ
    device   TEXT    NOT NULL DEFAULT '', -- mobile / tablet / desktop
    country  TEXT    NOT NULL DEFAULT ''  -- 国コード（JP など）
);

CREATE INDEX IF NOT EXISTS idx_events_day_type ON events (day, type);
CREATE INDEX IF NOT EXISTS idx_events_session ON events (session, type, name);

-- ログイン失敗の記録（総当たり対策）
CREATE TABLE IF NOT EXISTS login_failures (
    ts INTEGER NOT NULL
);
