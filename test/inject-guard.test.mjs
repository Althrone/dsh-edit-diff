import fs from 'node:fs'
import vm from 'node:vm'

// 回归测试：Cordis 的 Agent 是 Proxy —— 访问没有 inject 的属性会【抛异常】，
// 而不是返回 undefined。
//
// 曾经的 bug：sessionIdOfAgent 用数组字面量 [a.id, a.session?.id, ...]
// 让所有候选立刻求值，一个越界访问就让整轮拿不到基线、甚至整轮失败：
//   cannot get property "session" without inject

const src = fs.readFileSync('dsh-edit-diff/index.js', 'utf8')
const body = src.replace(/^import .*$/gm, '').replace(/^export /gm, '')

const sandbox = {
  console, Date, JSON, Map, Set, Math, String, Number, Array, Object, Error, setTimeout, Buffer,
  process: { cwd: () => 'C:/w' },
  statSync: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) },
  readFileSync: () => '',
}
sandbox.watch = () => ({ on() {}, close() {} })
vm.createContext(sandbox)
vm.runInContext(body + '\n;globalThis.__t = { sessionIdOfAgent, FALLBACK_SESSION_KEY, definition, beforeByCall };', sandbox)
const { sessionIdOfAgent, FALLBACK_SESSION_KEY, definition, beforeByCall } = sandbox.__t

let failures = 0
function check(name, fn) {
  try {
    if (fn() === false) throw new Error('returned false')
    console.log('ok   ' + name)
  } catch (e) {
    failures++
    console.log('FAIL ' + name + ': ' + e.message)
  }
}

/** 模拟 Cordis Proxy：访问未 inject 的属性抛异常。 */
function makeProxyLikeAgent({ allowed = {}, denied = [] } = {}) {
  const deniedSet = new Set(denied)
  return new Proxy(allowed, {
    get(target, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined
      if (deniedSet.has(prop)) {
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      }
      return Reflect.get(target, prop)
    },
    has(target, prop) {
      if (deniedSet.has(prop)) {
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      }
      return Reflect.has(target, prop)
    },
  })
}

check('agent.id 可用时正常返回', () => {
  const a = makeProxyLikeAgent({ allowed: { id: 'session-1' }, denied: ['session', 'sessionId'] })
  const got = sessionIdOfAgent(a)
  if (got !== 'session-1') throw new Error('got ' + JSON.stringify(got))
})

check('agent.id 缺失、session 被禁时不抛异常', () => {
  const a = makeProxyLikeAgent({ allowed: {}, denied: ['session', 'sessionId'] })
  let got
  try {
    got = sessionIdOfAgent(a)
  } catch (e) {
    throw new Error('threw instead of returning empty: ' + e.message)
  }
  if (got !== '') throw new Error('expected empty string, got ' + JSON.stringify(got))
})

check('只有 session.id 可用时能取到（sessionId 被禁）', () => {
  const a = makeProxyLikeAgent({
    allowed: { session: { id: 'from-session' } },
    denied: ['sessionId'],
  })
  const got = sessionIdOfAgent(a)
  if (got !== 'from-session') throw new Error('got ' + JSON.stringify(got))
})

check('session.header.id 可用时能取到', () => {
  const a = makeProxyLikeAgent({
    allowed: { session: { header: { id: 'from-header' } } },
    denied: ['sessionId', 'id'],
  })
  const got = sessionIdOfAgent(a)
  if (got !== 'from-header') throw new Error('got ' + JSON.stringify(got))
})

check('所有候选都被禁时返回空串且不抛', () => {
  const a = makeProxyLikeAgent({ allowed: {}, denied: ['id', 'sessionId', 'session', 'ctx'] })
  let got
  try {
    got = sessionIdOfAgent(a)
  } catch (e) {
    throw new Error('threw: ' + e.message)
  }
  if (got !== '') throw new Error('got ' + JSON.stringify(got))
})

check('嵌套访问 session.header 抛异常也能兜住', () => {
  // session 可读，但 header 被禁
  const inner = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'header') throw new Error('cannot get property "header" without inject')
      if (prop === 'id') return 'session-id-only'
      return undefined
    },
  })
  const a = makeProxyLikeAgent({ allowed: { session: inner }, denied: ['id', 'sessionId'] })
  const got = sessionIdOfAgent(a)
  if (got !== 'session-id-only') throw new Error('got ' + JSON.stringify(got))
})

check('null / undefined 安全', () => {
  if (sessionIdOfAgent(undefined) !== '') throw new Error('undefined')
  if (sessionIdOfAgent(null) !== '') throw new Error('null')
})

check('普通对象（非 Proxy）仍然工作', () => {
  if (sessionIdOfAgent({ id: 'plain' }) !== 'plain') throw new Error('plain id')
  if (sessionIdOfAgent({ session: { id: 'plain2' } }) !== 'plain2') throw new Error('plain session')
})

check('兜底 key 存在', () => {
  if (typeof FALLBACK_SESSION_KEY !== 'string' || FALLBACK_SESSION_KEY.length === 0) {
    throw new Error('missing fallback key')
  }
})

check('源码不再用数组字面量一次性求值', () => {
  // 旧写法：const candidates = [agent.id, agent.session?.id, ...]
  if (/const candidates = \[[\s\S]{0,200}agent\.session/.test(src)) {
    throw new Error('eager array literal is back — one denied property kills the whole access')
  }
})

check('编辑路径不依赖 agent 才能工作（state 自持基线）', () => {
  beforeByCall.clear()
  beforeByCall.set('c1', 'BEFORE')
  let s = definition.init({ id: 'sx' })
  s = definition.apply(s, {
    type: 'tool/call', time: 1,
    data: { callId: 'c1', name: 'edit', arguments: { file_path: 'a.c', old_string: 'x', new_string: 'y' } },
  })
  s = definition.apply(s, {
    type: 'tool/result', time: 2,
    data: { message: { source: { callId: 'c1' }, isError: false } },
  })
  const v = definition.wire.view(s).last
  if (v.beforeText !== 'BEFORE') throw new Error('baseline lost without agent')
})

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
