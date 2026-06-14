# Lessons Learned — TableTurn

## 1. 模板字符串禁止嵌套复杂表达式
❌ `message ${cond?'含奖励':''} more text`
✅ `'text' + (cond ? '含奖励' : '') + ' more text'`
推送前必须跑 `node -c server.js`。

## 2. 加导航按钮必须同时改两处
`onAuthSuccess()` 和 `startDemo()` 都要加 `classList.remove('hidden')`。下次抽成共享函数。

## 3. Express 静态文件优先于路由
`public/robots.txt` 优先于 `app.get('/robots.txt')`。静态文件直接改文件。

## 4. onclick 禁止嵌入 JSON
❌ `onclick="func(JSON.stringify(obj))"`
✅ `_cache[id] = obj; onclick="func(id)"`

## 5. edge-controller exec() 同步返回
异步操作分两步：`exec(action)` → `sleep N` → `exec(check)`

## 6. 截图前确认窗口
先确认 Edge 在前台，或用 edge-controller 直接截。
