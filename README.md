# portfolio-analytics

ポートフォリオサイト（https://haru2401game.github.io/portfolio/）のアクセス解析ツールです。
Cloudflare Workers と D1（データベース）だけで動き、**自分だけがログインできるダッシュボード**と
**毎朝5:00のDiscord日報**を作ります。Google アナリティクスは使いません。

## できること

| 機能 | 内容 |
|---|---|
| 記録 | 閲覧数・訪問数・読まれたセクション・クリックされた作品・Play Games・写真の拡大・外部リンク・連絡・流入元・端末・国 |
| ダッシュボード | 今日 / 7日 / 30日 / 90日の推移、セクション到達率、作品クリックのランキングなど（パスワードでログイン） |
| Discord日報 | 毎朝 5:00（日本時間）に前日分。閲覧数（前日比・前の7日平均）、セクション到達率、作品クリック TOP5、流入元、端末 |

### プライバシー

- Cookie・IPアドレス・端末IDは保存しません。訪問の区別には、タブを閉じると消えるランダムIDだけを使います。
- ポートフォリオ以外のサイトから送られた記録や、検索エンジンのボットなどの記録は保存しません。
- 記録は400日たつと自動で消えます。

## 仕組み

```
ポートフォリオ（js/analytics.js）
   │ 閲覧・クリックの記録
   ▼
Cloudflare Worker（src/index.js） ──► D1（events テーブル）
   │                     ▲
   │ cron 毎朝5:00        │ ログインした本人だけ
   ▼                     │
Discord に日報       ダッシュボード（public/）
```

| URL | 内容 |
|---|---|
| `/collect` | ポートフォリオから記録を受け取る（誰でも送れるが、許可したサイトからのみ保存） |
| `/` | ダッシュボード（ログインが必要） |
| `/login` | ログイン画面 |
| `/api/summary?days=7` | 集計データ（ログインが必要） |
| `/api/report` | 日報のテスト送信（ログインが必要。ダッシュボードの「日報テスト」ボタン） |

## セットアップ

パソコンに Node.js を入れる必要はありません。GitHub に push すると、Cloudflare が自動で取り込んで公開します（Cloudflare の「Workers Builds」機能）。

### 1. データベース（D1）を作る

1. Cloudflare ダッシュボード → **ストレージとデータベース** → **D1 SQL データベース** → **作成**
2. 名前を `portfolio-analytics` にして作成
3. 表示された **データベースID** を `wrangler.toml` の `database_id` に貼り付ける

### 2. GitHub に非公開リポジトリを作って push する

1. GitHub で **Private** の新しいリポジトリ `portfolio-analytics` を作成
2. このフォルダの中身を push

### 3. Cloudflare と GitHub をつなぐ

1. Cloudflare → **Workers & Pages** → **作成** → **Git リポジトリをインポート**（Import a repository）
2. GitHub と連携し、`portfolio-analytics` リポジトリを選ぶ
3. 設定
   - プロジェクト名：`portfolio-analytics`
   - ビルドコマンド：空欄
   - デプロイコマンド：`npx wrangler d1 migrations apply portfolio-analytics --remote && npx wrangler deploy`
4. **保存してデプロイ**

以降は、GitHub の `main` に push するたびに自動で公開されます。

### 4. 秘密の値を登録する

Cloudflare → **Workers & Pages** → `portfolio-analytics` → **設定** → **変数とシークレット** → **追加** で、種類を **シークレット** にして3つ登録します。

| 名前 | 入れるもの |
|---|---|
| `DASHBOARD_PASSWORD` | ダッシュボードのログインパスワード（長めのもの） |
| `SESSION_SECRET` | 40文字以上のランダムな文字列（パスワード管理アプリなどで生成。覚える必要はありません） |
| `DISCORD_WEBHOOK_URL` | 日報を送る Discord チャンネルの Webhook URL |

### 5. URL を設定する

`portfolio-analytics` の画面に表示される `https://portfolio-analytics.〇〇.workers.dev` を使って、

1. `wrangler.toml` の `DASHBOARD_URL` にそのURLを入れて push
2. ポートフォリオの `js/analytics.js` の `ENDPOINT` に `そのURL/collect` を入れて push

### 6. 自分のアクセスを除外する

自分がふだん使うブラウザ（PC・スマホそれぞれ）で、一度だけ次のURLを開きます。

```
https://haru2401game.github.io/portfolio/?notrack
```

以降、そのブラウザからの閲覧は記録されません。元に戻すときは `?track` を付けて開きます。

### 7. 動作確認

1. ダッシュボードのURLを開いてログイン
2. 別のブラウザ（または `?track` を付けたシークレットウィンドウ）でポートフォリオを見る
3. ダッシュボードで「今日」を選ぶと、数秒〜数十秒で数字が増えます
4. 「日報テスト」ボタンで、前日分の日報が Discord に届けば完了です

## カスタマイズ

- **日報の時刻**：`wrangler.toml` の `crons`（UTCで指定。日本時間 = UTC+9。`0 20 * * *` が毎朝5:00）
- **セクションの追加・並べ替え・削除**：**修正不要**。ポートフォリオの `<section id="…">` を自動で見つけて記録し、表示名は各セクションの見出し、並び順はページ上の順番になります（30日間記録のないセクションは一覧から自動で消えます）
- **記録する行動の追加**：`src/index.js` の `EVENT_TYPES` と、`js/analytics.js` のクリック処理
- **記録を残す日数**：`src/index.js` の `RETENTION_DAYS`

## ファイル構成

```
src/index.js                 Worker 本体（受け取り・ログイン・集計・日報）
migrations/                  データベースの表（0001：記録、0002：セクション一覧）
public/index.html, app.js    ダッシュボード
public/login.html            ログイン画面
public/style.css             見た目（ポートフォリオと同じ明るいゲームUI）
wrangler.toml                Cloudflare の設定
test/                        ローカル用のテスト（Node.js 22 以上で `npm test`）
```

## 料金

Cloudflare の無料プランの範囲で動きます（Workers：1日10万リクエスト、D1：5GB まで）。
ポートフォリオのアクセス数なら、上限に届くことはまずありません。

## セキュリティ対策

| 対策 | 内容 |
|---|---|
| ログイン | パスワードはハッシュにして比較。ログイン状態は署名付きCookie（HttpOnly・Secure・SameSite=Strict）で30日間 |
| 総当たり対策 | 同じ相手からのログインは1分に5回まで（`LOGIN_LIMITER`）。全体でも15分に30回失敗すると一時停止 |
| 他サイトからの操作 | 他のサイトに置かれたフォームからのログイン・日報テスト送信は拒否 |
| 荒らし対策 | 記録の送信は同じ相手から1分に120回まで（`COLLECT_LIMITER`）、いいねは90回まで（`LIKE_LIMITER`）。1日に保存する記録は20,000件まで |
| 画面の保護 | Content-Security-Policy で、自分のファイルと Google Fonts 以外は読み込まない。他サイトへの埋め込みも禁止 |
| 日報 | 誰でも送れる記録の名前から、Discord のリンク・メンション・書式になる文字を取り除いてから送る |

IPアドレスは、Cloudflare が回数を数えるのに使うだけで、データベースには保存しません。

### 困ったとき

- **全部の端末をログアウトさせたい**（Cookie が漏れたかも、など）：Cloudflare で `SESSION_SECRET` を新しいランダムな値に変える。今までのログインはすべて無効になる
- **パスワードを変えたい**：`DASHBOARD_PASSWORD` を変える。16文字以上のランダムな文字列がおすすめ
