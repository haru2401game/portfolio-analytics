-- ポートフォリオのセクション一覧（ポートフォリオ側から自動で届く）
-- 新しいセクションを追加・並べ替え・削除しても、分析ツール側の修正は不要
CREATE TABLE IF NOT EXISTS sections (
    id      TEXT PRIMARY KEY,           -- セクションの id（例：about）
    label   TEXT    NOT NULL,           -- 表示名（セクションの見出し）
    ord     INTEGER NOT NULL,           -- ページ上の順番
    updated INTEGER NOT NULL            -- 最後に届いた時刻（UNIXミリ秒）
);
