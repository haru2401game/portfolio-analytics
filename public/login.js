/* ログイン画面：エラーの表示（決まった文章だけを表示する） */
const messages = {
    "1": "パスワードが違います。",
    "locked": "ログインの失敗が続いたため、15分ほど停止しています。",
    "setup": "パスワードがまだ設定されていません（README の手順を確認してください）。",
};
const code = new URLSearchParams(location.search).get("error");
if (code && messages[code]) {
    const box = document.getElementById("error");
    box.textContent = messages[code];
    box.hidden = false;
}
